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
	TotalChunks int    `json:"totalChunks"` // Removed omitempty
	Index       int    `json:"index"`       // Removed omitempty (Fixes missing chunk 0)
	Content     string `json:"content,omitempty"`
	Error       string `json:"error,omitempty"`
	ReceiverID  string `json:"receiverId,omitempty"`
	FileID      string `json:"fileId,omitempty"`
	FileIndex   int    `json:"fileIndex"`  // Removed omitempty
	TotalFiles  int    `json:"totalFiles"` // Removed omitempty
	Receivers   int    `json:"receivers"`  // Removed omitempty
	Text        string `json:"text,omitempty"`
	MessageID   string `json:"messageId,omitempty"`
	Timestamp   int64  `json:"timestamp,omitempty"`
}

// Receiver represents a connected receiver client
type Receiver struct {
	Conn     *websocket.Conn
	ID       string
	JoinedAt time.Time
	mu       sync.Mutex
}

// Session represents a file sharing session
type Session struct {
	Code         string
	Sender       *websocket.Conn
	Receivers    map[string]*Receiver
	CreatedAt    time.Time
	LastActivity time.Time
	mu           sync.RWMutex
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

	// Default encryption key warning
	if os.Getenv("GOSHARE_ENCRYPTION_KEY") == "" {
		log.Println("WARNING: GOSHARE_ENCRYPTION_KEY is not set. Using default insecure key.")
		os.Setenv("GOSHARE_ENCRYPTION_KEY", "default-insecure-key-123")
	}

	hotpSecretRaw := os.Getenv("GOSHARE_HOTP_SECRET")
	if hotpSecretRaw == "" {
		log.Println("WARNING: GOSHARE_HOTP_SECRET is not set. Using default insecure key.")
		hotpSecretRaw = "defaultsecret" // Fallback
	}
	hotpSecret = base32.StdEncoding.EncodeToString([]byte(hotpSecretRaw))

	// Start session cleanup routine
	go cleanupExpiredSessions()

	// Set up HTTP server
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
	var isSender bool

	// Start ping routine
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
		// Cleanup on disconnect
		if sessionCode != "" {
			sessionsLock.RLock()
			session, exists := sessions[sessionCode]
			sessionsLock.RUnlock()

			if exists {
				session.mu.Lock()
				if receiverID != "" {
					// Remove receiver
					delete(session.Receivers, receiverID)
					receiverCount := len(session.Receivers)
					log.Printf("Receiver %s disconnected from session %s (%d remaining)", receiverID, sessionCode, receiverCount)

					// Notify sender about receiver count
					if session.Sender != nil {
						notifyMsg := Message{
							Type:      "receiver_count",
							Receivers: receiverCount,
						}
						msgBytes, _ := json.Marshal(notifyMsg)
						session.Sender.WriteMessage(websocket.TextMessage, msgBytes)
					}
				} else if isSender {
					// Sender disconnected, notify all receivers
					log.Printf("Sender disconnected from session %s", sessionCode)
					session.Sender = nil // Mark sender as gone
					for _, receiver := range session.Receivers {
						disconnectMsg := Message{Type: "sender_disconnected"}
						msgBytes, _ := json.Marshal(disconnectMsg)
						receiver.Conn.WriteMessage(websocket.TextMessage, msgBytes)
					}
				}
				session.mu.Unlock()

				// If no receivers left and sender gone, clean up session
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
				Code:         code,
				Receivers:    make(map[string]*Receiver),
				CreatedAt:    time.Now(),
				LastActivity: time.Now(),
				Sender:       conn,
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

			sessionsLock.RLock()
			session, exists := sessions[code]
			sessionsLock.RUnlock()

			if !exists {
				errorMsg := Message{Type: "error", Error: "Invalid code"}
				errorBytes, _ := json.Marshal(errorMsg)
				conn.WriteMessage(websocket.TextMessage, errorBytes)
				return // Disconnect
			}

			session.mu.Lock()
			if len(session.Receivers) >= MaxReceivers {
				session.mu.Unlock()
				errorMsg := Message{Type: "error", Error: "Session is full"}
				errorBytes, _ := json.Marshal(errorMsg)
				conn.WriteMessage(websocket.TextMessage, errorBytes)
				return
			}

			receiver := &Receiver{
				Conn:     conn,
				ID:       receiverID,
				JoinedAt: time.Now(),
			}
			session.Receivers[receiverID] = receiver
			receiverCount := len(session.Receivers)
			session.LastActivity = time.Now()
			session.mu.Unlock()

			log.Printf("Receiver %s joined session %s (%d total)", receiverID, code, receiverCount)

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
			// Forward encrypted text message to all receivers
			sessionsLock.RLock()
			session, exists := sessions[msg.Code]
			sessionsLock.RUnlock()

			if exists {
				session.mu.Lock()
				session.LastActivity = time.Now()
				session.mu.Unlock()

				textMsg := Message{
					Type:      "text_message",
					Text:      msg.Text,
					MessageID: msg.MessageID,
					Timestamp: time.Now().Unix(),
				}
				textMsgBytes, _ := json.Marshal(textMsg)

				session.mu.RLock()
				receiverCount := 0
				for _, receiver := range session.Receivers {
					receiver.mu.Lock()
					if err := receiver.Conn.WriteMessage(websocket.TextMessage, textMsgBytes); err == nil {
						receiverCount++
					} else {
						log.Printf("Error sending text to receiver %s: %v", receiver.ID, err)
					}
					receiver.mu.Unlock()
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

// Helper to reduce code duplication and handle broadcast errors
func broadcastToReceivers(msg Message, msgType string) {
	sessionsLock.RLock()
	session, exists := sessions[msg.Code]
	sessionsLock.RUnlock()

	if exists {
		session.mu.Lock()
		session.LastActivity = time.Now()
		session.mu.Unlock()

		// Construct message to forward (stripping some internal fields if needed)
		forwardMsg := msg
		forwardMsg.Type = msgType
		msgBytes, _ := json.Marshal(forwardMsg)

		session.mu.RLock()
		for _, receiver := range session.Receivers {
			receiver.mu.Lock()
			// We ignore write errors here to avoid blocking other receivers,
			// but we could log them. The receiver cleanup loop or ping
			// handler will eventually catch dead connections.
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
