package main

import (
	"encoding/base32"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
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
	TotalChunks int    `json:"totalChunks,omitempty"`
	Index       int    `json:"index,omitempty"`
	Content     string `json:"content,omitempty"`
	Error       string `json:"error,omitempty"`
	ReceiverID  string `json:"receiverId,omitempty"`
	FileID      string `json:"fileId,omitempty"`
	FileIndex   int    `json:"fileIndex,omitempty"`
	TotalFiles  int    `json:"totalFiles,omitempty"`
	Receivers   int    `json:"receivers,omitempty"`
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
	hotpSecret          = base32.StdEncoding.EncodeToString([]byte("your-secret-key-change-in-production"))
	counter      uint64 = uint64(time.Now().Unix())
	counterLock  sync.Mutex
)

func main() {
	// Start session cleanup routine
	go cleanupExpiredSessions()

	// Set up HTTP server
	http.Handle("/", http.FileServer(http.Dir("./public")))
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/health", healthCheck)

	port := ":4000"
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
		case "register":
			// Create new session for receiver
			code := generateJoinCode()
			sessionCode = code
			receiverID = uuid.New().String()

			session := &Session{
				Code:         code,
				Receivers:    make(map[string]*Receiver),
				CreatedAt:    time.Now(),
				LastActivity: time.Now(),
			}

			receiver := &Receiver{
				Conn:     conn,
				ID:       receiverID,
				JoinedAt: time.Now(),
			}

			session.Receivers[receiverID] = receiver

			sessionsLock.Lock()
			sessions[code] = session
			sessionsLock.Unlock()

			log.Printf("New session created: %s (receiver: %s)", code, receiverID)

			responseMsg := Message{
				Type:       "code",
				Code:       code,
				ReceiverID: receiverID,
			}
			responseBytes, _ := json.Marshal(responseMsg)
			conn.WriteMessage(websocket.TextMessage, responseBytes)

		case "join":
			// Additional receiver joining existing session
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
				return
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

			// Send confirmation to new receiver
			joinedMsg := Message{
				Type:       "joined",
				ReceiverID: receiverID,
				Code:       code,
			}
			joinedBytes, _ := json.Marshal(joinedMsg)
			conn.WriteMessage(websocket.TextMessage, joinedBytes)

			// Notify sender about new receiver
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

		case "connect":
			// Sender connecting to session
			code := msg.Code
			sessionCode = code
			isSender = true

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
			session.Sender = conn
			receiverCount := len(session.Receivers)
			session.LastActivity = time.Now()
			session.mu.Unlock()

			log.Printf("Sender connected to session %s (%d receivers)", code, receiverCount)

			// Notify sender
			connectedMsg := Message{
				Type:      "connected",
				Receivers: receiverCount,
			}
			connectedBytes, _ := json.Marshal(connectedMsg)
			conn.WriteMessage(websocket.TextMessage, connectedBytes)

			// Notify all receivers
			session.mu.RLock()
			for _, receiver := range session.Receivers {
				receiver.mu.Lock()
				senderConnectedMsg := Message{Type: "sender_connected"}
				msgBytes, _ := json.Marshal(senderConnectedMsg)
				receiver.Conn.WriteMessage(websocket.TextMessage, msgBytes)
				receiver.mu.Unlock()
			}
			session.mu.RUnlock()

		case "metadata":
			// Forward metadata to all receivers
			sessionsLock.RLock()
			session, exists := sessions[msg.Code]
			sessionsLock.RUnlock()

			if exists {
				session.mu.Lock()
				session.LastActivity = time.Now()
				session.mu.Unlock()

				metadataMsg := Message{
					Type:        "metadata",
					Name:        msg.Name,
					Size:        msg.Size,
					TotalChunks: msg.TotalChunks,
					FileID:      msg.FileID,
					FileIndex:   msg.FileIndex,
					TotalFiles:  msg.TotalFiles,
				}
				metadataBytes, _ := json.Marshal(metadataMsg)

				session.mu.RLock()
				for _, receiver := range session.Receivers {
					receiver.mu.Lock()
					receiver.Conn.WriteMessage(websocket.TextMessage, metadataBytes)
					receiver.mu.Unlock()
				}
				session.mu.RUnlock()

				log.Printf("Forwarded metadata for %s to %d receivers", msg.Name, len(session.Receivers))
			}

		case "chunk":
			// Forward chunk to all receivers
			sessionsLock.RLock()
			session, exists := sessions[msg.Code]
			sessionsLock.RUnlock()

			if exists {
				session.mu.Lock()
				session.LastActivity = time.Now()
				session.mu.Unlock()

				chunkMsg := Message{
					Type:    "chunk",
					Index:   msg.Index,
					Content: msg.Content,
					FileID:  msg.FileID,
				}
				chunkBytes, _ := json.Marshal(chunkMsg)

				session.mu.RLock()
				for _, receiver := range session.Receivers {
					receiver.mu.Lock()
					receiver.Conn.WriteMessage(websocket.TextMessage, chunkBytes)
					receiver.mu.Unlock()
				}
				session.mu.RUnlock()
			}

		case "done":
			// Forward completion message to all receivers
			sessionsLock.RLock()
			session, exists := sessions[msg.Code]
			sessionsLock.RUnlock()

			if exists {
				session.mu.Lock()
				session.LastActivity = time.Now()
				session.mu.Unlock()

				doneMsg := Message{
					Type:   "done",
					Name:   msg.Name,
					FileID: msg.FileID,
				}
				doneBytes, _ := json.Marshal(doneMsg)

				session.mu.RLock()
				for _, receiver := range session.Receivers {
					receiver.mu.Lock()
					receiver.Conn.WriteMessage(websocket.TextMessage, doneBytes)
					receiver.mu.Unlock()
				}
				session.mu.RUnlock()

				log.Printf("Transfer complete: %s", msg.Name)
			}

		case "all_done":
			// All files sent
			sessionsLock.RLock()
			session, exists := sessions[msg.Code]
			sessionsLock.RUnlock()

			if exists {
				allDoneMsg := Message{Type: "all_done"}
				allDoneBytes, _ := json.Marshal(allDoneMsg)

				session.mu.RLock()
				for _, receiver := range session.Receivers {
					receiver.mu.Lock()
					receiver.Conn.WriteMessage(websocket.TextMessage, allDoneBytes)
					receiver.mu.Unlock()
				}
				session.mu.RUnlock()

				log.Printf("All files transferred for session %s", msg.Code)
			}

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
					}
					receiver.mu.Unlock()
				}
				session.mu.RUnlock()

				log.Printf("Text message forwarded to %d receivers in session %s", receiverCount, msg.Code)

				// Send acknowledgment back to sender
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
