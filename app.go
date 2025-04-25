package main

import (
	"encoding/base32"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pquerna/otp/hotp"
)

type Message struct {
	Type    string `json:"type"`
	Code    string `json:"code,omitempty"`
	Name    string `json:"name,omitempty"`
	Index   int    `json:"index,omitempty"`
	Content string `json:"content,omitempty"`
}

type Session struct {
	Receiver *websocket.Conn
	Sender   *websocket.Conn
}

var upgrader = websocket.Upgrader{}
var sessions = make(map[string]*Session)
var peersLock sync.Mutex

var hotpSecret = base32.StdEncoding.EncodeToString([]byte("your-secret-key"))
var counter uint64 = uint64(time.Now().Unix())

func main() {
	http.Handle("/", http.FileServer(http.Dir("./public")))
	http.HandleFunc("/ws", handleWebSocket)

	fmt.Println("Server started at http://localhost:5050")
	log.Fatal(http.ListenAndServe(":5050", nil))
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	upgrader.CheckOrigin = func(r *http.Request) bool { return true }
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade error:", err)
		return
	}
	defer conn.Close()

	var joinCode string

	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			log.Println("WebSocket read error:", err)
			break
		}

		switch msg.Type {
		case "register":
			log.Printf("Received: %+v", msg)
			//NOTE: Check if the joinCode is unique
			joinCode = generateJoinCode()
			peersLock.Lock()
			sessions[joinCode] = &Session{Receiver: conn}
			peersLock.Unlock()
			conn.WriteJSON(Message{Type: "code", Code: joinCode})
		case "connect":
			log.Printf("Received: %+v", msg)
			peersLock.Lock()
			session, ok := sessions[msg.Code]
			peersLock.Unlock()
			if ok {
				session.Sender = conn
				session.Sender.WriteJSON(Message{Type: "connected"})
				session.Receiver.WriteJSON(Message{Type: "connected"})
			} else {
				conn.WriteJSON(Message{Type: "error", Content: "Invalid code"})
			}
		case "chunk":
			peersLock.Lock()
			session, ok := sessions[msg.Code]
			peersLock.Unlock()
			if ok && session.Receiver != nil {
				err := session.Receiver.WriteJSON(Message{
					Type:    "chunk",
					Index:   msg.Index,
					Name:    msg.Name,
					Content: msg.Content,
				})
				if err != nil {
					log.Println("Error forwarding chunk:", err)
				}
			}
		case "done":
			log.Printf("Received: %+v", msg)
			peersLock.Lock()
			session, ok := sessions[msg.Code]
			peersLock.Unlock()
			if ok && session.Receiver != nil {
				session.Receiver.WriteJSON(Message{
					Type: "done",
					Name: msg.Name,
				})
			}
		}
	}

	if joinCode != "" {
		peersLock.Lock()
		delete(sessions, joinCode)
		peersLock.Unlock()
	}
}

func generateJoinCode() string {
	counter++
	code, err := hotp.GenerateCode(string(hotpSecret), counter)
	if err != nil {
		log.Println("HOTP generation failed:", err)
		return fmt.Sprintf("%06d", 000000)
	}
	return code
}
