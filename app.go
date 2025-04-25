package main

import (
	"encoding/base32"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pquerna/otp/hotp"
)

// Message represents WebSocket message structure
type Message struct {
	Type        string `json:"type"`
	Code        string `json:"code,omitempty"`
	Name        string `json:"name,omitempty"`
	Size        int64  `json:"size,omitempty"`
	TotalChunks int    `json:"totalChunks,omitempty"`
	Index       int    `json:"index"`
	Content     string `json:"content,omitempty"`
}

// Session represents a connection between sender and receiver
type Session struct {
	Receiver *websocket.Conn
	Sender   *websocket.Conn
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024 * 1024, // 1MB
	WriteBufferSize: 1024 * 1024, // 1MB
	CheckOrigin:     func(r *http.Request) bool { return true },
}

var (
	sessions   = make(map[string]*Session)
	peersLock  sync.Mutex
	hotpSecret        = base32.StdEncoding.EncodeToString([]byte("your-secret-key"))
	counter    uint64 = uint64(time.Now().Unix())
)

func main() {
	// Set up HTTP server
	http.Handle("/", http.FileServer(http.Dir("./public")))
	http.HandleFunc("/ws", handleWebSocket)

	fmt.Println("Server started at http://localhost:5050")
	log.Fatal(http.ListenAndServe(":5050", nil))
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade the HTTP connection to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade error:", err)
		return
	}

	// Configure WebSocket connection for larger messages
	conn.SetReadLimit(10 * 1024 * 1024) // 10MB max message size
	conn.SetWriteDeadline(time.Now().Add(60 * time.Second))

	defer conn.Close()

	log.Println("New WebSocket connection established")

	var joinCode string

	for {
		// Read next message
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			log.Println("WebSocket read error:", err)
			break
		}

		if messageType != websocket.TextMessage {
			log.Println("Received non-text message, ignoring")
			continue
		}

		// Parse message
		var msg Message
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Error parsing JSON: %v", err)
			continue
		}

		log.Printf("Received message type: %s", msg.Type)

		switch msg.Type {
		case "register":
			// Generate a unique join code
			joinCode = generateJoinCode()
			log.Printf("Registering new receiver with code: %s", joinCode)

			peersLock.Lock()
			sessions[joinCode] = &Session{Receiver: conn}
			peersLock.Unlock()

			// Send code back to client
			responseMsg := Message{Type: "code", Code: joinCode}
			responseBytes, _ := json.Marshal(responseMsg)
			if err := conn.WriteMessage(websocket.TextMessage, responseBytes); err != nil {
				log.Printf("Error sending code: %v", err)
			}

		case "connect":
			log.Printf("Sender connecting with code: %s", msg.Code)

			peersLock.Lock()
			session, ok := sessions[msg.Code]
			peersLock.Unlock()

			if ok && session.Receiver != nil {
				session.Sender = conn

				// Notify both sender and receiver of connection
				connectedMsg := Message{Type: "connected"}
				connectedBytes, _ := json.Marshal(connectedMsg)

				if err := conn.WriteMessage(websocket.TextMessage, connectedBytes); err != nil {
					log.Printf("Error notifying sender: %v", err)
				}

				if err := session.Receiver.WriteMessage(websocket.TextMessage, connectedBytes); err != nil {
					log.Printf("Error notifying receiver: %v", err)
				}
			} else {
				errorMsg := Message{Type: "error", Content: "Invalid code"}
				errorBytes, _ := json.Marshal(errorMsg)
				conn.WriteMessage(websocket.TextMessage, errorBytes)
			}

		case "metadata":
			peersLock.Lock()
			session, ok := sessions[msg.Code]
			peersLock.Unlock()

			if ok && session.Receiver != nil {
				log.Printf("Forwarding metadata: name=%s, size=%d, chunks=%d",
					msg.Name, msg.Size, msg.TotalChunks)

				metadataMsg := Message{
					Type:        "metadata",
					Name:        msg.Name,
					Size:        msg.Size,
					TotalChunks: msg.TotalChunks,
				}

				metadataBytes, _ := json.Marshal(metadataMsg)
				if err := session.Receiver.WriteMessage(websocket.TextMessage, metadataBytes); err != nil {
					log.Printf("Error sending metadata: %v", err)
				}
			}

		case "chunk":
			peersLock.Lock()
			session, ok := sessions[msg.Code]
			peersLock.Unlock()

			if ok && session.Receiver != nil {
				// Important: Send complete chunk data including index
				chunkMsg := Message{
					Type:    "chunk",
					Index:   msg.Index,
					Content: msg.Content,
				}

				chunkBytes, err := json.Marshal(chunkMsg)
				if err != nil {
					log.Printf("Error marshaling chunk: %v", err)
					continue
				}

				if err := session.Receiver.WriteMessage(websocket.TextMessage, chunkBytes); err != nil {
					log.Printf("Error sending chunk %d: %v", msg.Index, err)
				} else {
					log.Printf("Forwarded chunk %d (%d bytes JSON)", msg.Index, len(chunkBytes))
				}
			}

		case "done":
			peersLock.Lock()
			session, ok := sessions[msg.Code]
			peersLock.Unlock()

			if ok && session.Receiver != nil {
				log.Printf("Transfer complete: %s", msg.Name)

				doneMsg := Message{
					Type: "done",
					Name: msg.Name,
				}

				doneBytes, _ := json.Marshal(doneMsg)
				if err := session.Receiver.WriteMessage(websocket.TextMessage, doneBytes); err != nil {
					log.Printf("Error sending done message: %v", err)
				}
			}
		}
	}

	// Clean up when connection closes
	if joinCode != "" {
		peersLock.Lock()
		delete(sessions, joinCode)
		peersLock.Unlock()
		log.Printf("Session cleaned up: %s", joinCode)
	}
}

func generateJoinCode() string {
	counter++
	code, err := hotp.GenerateCode(hotpSecret, counter)
	if err != nil {
		log.Println("HOTP generation failed:", err)
		return fmt.Sprintf("%06d", time.Now().Unix()%1000000)
	}
	return code
}
