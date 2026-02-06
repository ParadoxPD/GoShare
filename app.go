package main

import (
	"encoding/base32"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	"github.com/pquerna/otp/hotp"
)

const (
	MaxReceivers   = 10
	MaxMessageSize = 10 * 1024 * 1024 // 10MB
	WriteTimeout   = 60 * time.Second
	ReadTimeout    = 300 * time.Second
	SessionTimeout = 30 * time.Minute
	PingInterval   = 30 * time.Second
)

// Message represents WebSocket message structure
type Message struct {
	Type        string `json:"type"`
	Code        string `json:"code,omitempty"`
	Name        string `json:"name,omitempty"`
	Size        int64  `json:"size,omitempty"`
	TotalChunks int    `json:"totalChunks"`
	Index       int    `json:"index"`
	Content     string `json:"content,omitempty"`
	Error       string `json:"error,omitempty"`
	ReceiverID  string `json:"receiverId,omitempty"`
	FileID      string `json:"fileId,omitempty"`
	FileIndex   int    `json:"fileIndex"`
	TotalFiles  int    `json:"totalFiles"`
	Receivers   int    `json:"receivers"`
	Text        string `json:"text,omitempty"`
	MessageID   string `json:"messageId,omitempty"`
	Timestamp   int64  `json:"timestamp,omitempty"`
	SenderName  string `json:"senderName,omitempty"`
}

// Receiver represents a connected receiver client
type Receiver struct {
	Conn         *websocket.Conn
	ID           string
	ConnectionID string // NEW: Unique connection identifier
	JoinedAt     time.Time
	mu           sync.Mutex
}

// Session represents a file sharing session
type Session struct {
	Code          string
	Sender        *websocket.Conn
	Receivers     map[string]*Receiver
	ConnectionIDs map[string]bool // NEW: Track unique connection IDs
	CreatedAt     time.Time
	LastActivity  time.Time
	mu            sync.RWMutex
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024 * 1024,
	WriteBufferSize: 1024 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

var (
	sessions     = make(map[string]*Session)
	sessionsLock sync.RWMutex
	hotpSecret          = ""
	counter      uint64 = uint64(time.Now().Unix())
	counterLock  sync.Mutex
)

func main() {
	godotenv.Load()

	if os.Getenv("GOSHARE_ENCRYPTION_KEY") == "" {
		log.Println("WARNING: GOSHARE_ENCRYPTION_KEY is not set. Using default insecure key.")
		os.Setenv("GOSHARE_ENCRYPTION_KEY", "default-insecure-key-123")
	}

	hotpSecretRaw := os.Getenv("GOSHARE_HOTP_SECRET")
	if hotpSecretRaw == "" {
		log.Println("WARNING: GOSHARE_HOTP_SECRET is not set. Using default insecure key.")
		hotpSecretRaw = "defaultsecret"
	}
	hotpSecret = base32.StdEncoding.EncodeToString([]byte(hotpSecretRaw))

	go cleanupExpiredSessions()

	http.Handle("/", http.FileServer(http.Dir("./public")))
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/health", healthCheck)
	http.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"key": os.Getenv("GOSHARE_ENCRYPTION_KEY"),
		})
	})

	port := fmt.Sprintf(":%s", os.Getenv("PORT"))
	if port == ":" {
		log.Fatal("PORT not defined")
		os.Exit(1)
	}

	fmt.Printf("🚀 Server started at http://localhost%s\n", port)
	log.Fatal(http.ListenAndServe(port, nil))
}

func healthCheck(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK")
}

func cleanupExpiredSessions() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		sessionsLock.Lock()
		now := time.Now()
		for code, session := range sessions {
			session.mu.RLock()
			expired := now.Sub(session.LastActivity) > SessionTimeout
			session.mu.RUnlock()

			if expired {
				log.Printf("Cleaning up expired session: %s", code)
				delete(sessions, code)
			}
		}
		sessionsLock.Unlock()
	}
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade error:", err)
		return
	}

	conn.SetReadLimit(MaxMessageSize)
	conn.SetReadDeadline(time.Now().Add(ReadTimeout))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(ReadTimeout))
		return nil
	})

	defer conn.Close()

	log.Println("New WebSocket connection from", r.RemoteAddr)

	var sessionCode string
	var receiverID string
	var connectionID string // NEW: Track connection ID
	var isSender bool

	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(PingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second)); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()

	defer func() {
		close(done)
		if sessionCode != "" {
			sessionsLock.RLock()
			session, exists := sessions[sessionCode]
			sessionsLock.RUnlock()

			if exists {
				session.mu.Lock()
				if receiverID != "" {
					delete(session.Receivers, receiverID)
					// NEW: Remove connection ID tracking
					if connectionID != "" {
						delete(session.ConnectionIDs, connectionID)
					}
					receiverCount := len(session.Receivers)
					log.Printf("Receiver %s disconnected from session %s (%d remaining)", receiverID, sessionCode, receiverCount)

					if session.Sender != nil {
						notifyMsg := Message{
							Type:      "receiver_count",
							Receivers: receiverCount,
						}
						msgBytes, _ := json.Marshal(notifyMsg)
						session.Sender.WriteMessage(websocket.TextMessage, msgBytes)
					}
				} else if isSender {
					log.Printf("Sender disconnected from session %s", sessionCode)
					session.Sender = nil
					for _, receiver := range session.Receivers {
						disconnectMsg := Message{Type: "sender_disconnected"}
						msgBytes, _ := json.Marshal(disconnectMsg)
						receiver.Conn.WriteMessage(websocket.TextMessage, msgBytes)
					}
				}
				session.mu.Unlock()

				session.mu.RLock()
				shouldDelete := len(session.Receivers) == 0 && session.Sender == nil
				session.mu.RUnlock()

				if shouldDelete {
					sessionsLock.Lock()
					delete(sessions, sessionCode)
					sessionsLock.Unlock()
					log.Printf("Session %s fully cleaned up", sessionCode)
				}
			}
		}
	}()

	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		if messageType != websocket.TextMessage {
			continue
		}

		var msg Message
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Error parsing JSON: %v", err)
			continue
		}

		conn.SetReadDeadline(time.Now().Add(ReadTimeout))

		switch msg.Type {
		case "create_session":
			code := generateJoinCode()
			sessionCode = code
			isSender = true

			session := &Session{
				Code:          code,
				Receivers:     make(map[string]*Receiver),
				ConnectionIDs: make(map[string]bool), // NEW
				CreatedAt:     time.Now(),
				LastActivity:  time.Now(),
				Sender:        conn,
			}

			sessionsLock.Lock()
			sessions[code] = session
			sessionsLock.Unlock()

			log.Printf("New session created by sender: %s", code)

			responseMsg := Message{
				Type: "code",
				Code: code,
			}
			responseBytes, _ := json.Marshal(responseMsg)
			conn.WriteMessage(websocket.TextMessage, responseBytes)

		case "join":
			code := msg.Code
			sessionCode = code
			receiverID = uuid.New().String()
			connectionID = msg.ReceiverID // NEW: Use client-provided connection ID

			sessionsLock.RLock()
			session, exists := sessions[code]
			sessionsLock.RUnlock()

			if !exists {
				errorMsg := Message{Type: "error", Error: "Invalid code"}
				errorBytes, _ := json.Marshal(errorMsg)
				conn.WriteMessage(websocket.TextMessage, errorBytes)
				return
			}

			session.mu.Lock()

			// NEW: Check if this connection ID already exists
			if session.ConnectionIDs[connectionID] {
				session.mu.Unlock()
				warningMsg := Message{Type: "warning", Error: "You are already connected to this session"}
				warningBytes, _ := json.Marshal(warningMsg)
				conn.WriteMessage(websocket.TextMessage, warningBytes)
				// Don't return - let the connection stay open but don't join again
				continue
			}

			if len(session.Receivers) >= MaxReceivers {
				session.mu.Unlock()
				errorMsg := Message{Type: "error", Error: "Session is full"}
				errorBytes, _ := json.Marshal(errorMsg)
				conn.WriteMessage(websocket.TextMessage, errorBytes)
				return
			}

			receiver := &Receiver{
				Conn:         conn,
				ID:           receiverID,
				ConnectionID: connectionID, // NEW
				JoinedAt:     time.Now(),
			}
			session.Receivers[receiverID] = receiver
			session.ConnectionIDs[connectionID] = true // NEW: Track this connection
			receiverCount := len(session.Receivers)
			session.LastActivity = time.Now()
			session.mu.Unlock()

			log.Printf("Receiver %s (conn: %s) joined session %s (%d total)", receiverID, connectionID, code, receiverCount)

			joinedMsg := Message{
				Type:       "joined",
				ReceiverID: receiverID,
				Code:       code,
			}
			joinedBytes, _ := json.Marshal(joinedMsg)
			conn.WriteMessage(websocket.TextMessage, joinedBytes)

			session.mu.RLock()
			if session.Sender != nil {
				notifyMsg := Message{
					Type:      "receiver_count",
					Receivers: receiverCount,
				}
				msgBytes, _ := json.Marshal(notifyMsg)
				session.Sender.WriteMessage(websocket.TextMessage, msgBytes)
			}
			session.mu.RUnlock()

		case "metadata":
			broadcastToReceivers(msg, "metadata")

		case "chunk":
			broadcastToReceivers(msg, "chunk")

		case "done":
			broadcastToReceivers(msg, "done")

		case "all_done":
			broadcastToReceivers(msg, "all_done")

		case "text_message":
			// NEW: Support bidirectional messaging
			sessionsLock.RLock()
			session, exists := sessions[msg.Code]
			sessionsLock.RUnlock()

			if exists {
				session.mu.Lock()
				session.LastActivity = time.Now()
				session.mu.Unlock()

				textMsg := Message{
					Type:       "text_message",
					Text:       msg.Text,
					MessageID:  msg.MessageID,
					Timestamp:  time.Now().Unix(),
					SenderName: msg.SenderName, // NEW: Include sender identifier
				}
				textMsgBytes, _ := json.Marshal(textMsg)

				session.mu.RLock()
				receiverCount := 0

				// If sender is sending, broadcast to all receivers
				if isSender {
					for _, receiver := range session.Receivers {
						receiver.mu.Lock()
						if err := receiver.Conn.WriteMessage(websocket.TextMessage, textMsgBytes); err == nil {
							receiverCount++
						} else {
							log.Printf("Error sending text to receiver %s: %v", receiver.ID, err)
						}
						receiver.mu.Unlock()
					}
				} else {
					// NEW: If receiver is sending, send to sender
					if session.Sender != nil {
						if err := session.Sender.WriteMessage(websocket.TextMessage, textMsgBytes); err == nil {
							receiverCount = 1
						} else {
							log.Printf("Error sending text to sender: %v", err)
						}
					}
				}
				session.mu.RUnlock()

				ackMsg := Message{
					Type:      "text_ack",
					MessageID: msg.MessageID,
					Receivers: receiverCount,
				}
				ackBytes, _ := json.Marshal(ackMsg)
				conn.WriteMessage(websocket.TextMessage, ackBytes)
			}
		}
	}
}

func broadcastToReceivers(msg Message, msgType string) {
	sessionsLock.RLock()
	session, exists := sessions[msg.Code]
	sessionsLock.RUnlock()

	if exists {
		session.mu.Lock()
		session.LastActivity = time.Now()
		session.mu.Unlock()

		forwardMsg := msg
		forwardMsg.Type = msgType
		msgBytes, _ := json.Marshal(forwardMsg)

		session.mu.RLock()
		for _, receiver := range session.Receivers {
			receiver.mu.Lock()
			receiver.Conn.WriteMessage(websocket.TextMessage, msgBytes)
			receiver.mu.Unlock()
		}
		session.mu.RUnlock()
	}
}

func generateJoinCode() string {
	counterLock.Lock()
	counter++
	currentCounter := counter
	counterLock.Unlock()

	code, err := hotp.GenerateCode(hotpSecret, currentCounter)
	if err != nil {
		log.Println("HOTP generation failed:", err)
		return fmt.Sprintf("%06d", time.Now().Unix()%1000000)
	}
	return code
}
