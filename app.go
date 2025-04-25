package main

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base32"
	"encoding/base64"
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
	Content string `json:"content,omitempty"`
}

var upgrader = websocket.Upgrader{}
var peers = make(map[string]*websocket.Conn)
var peersLock sync.Mutex

var hotpSecret = base32.StdEncoding.EncodeToString([]byte("your-secret-key"))

var counter uint64 = uint64(time.Now().Unix())
var aesKey = []byte("examplekey123456") // 16 bytes for AES-128

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
			joinCode = generateJoinCode()
			peersLock.Lock()
			peers[joinCode] = conn
			peersLock.Unlock()
			conn.WriteJSON(Message{Type: "code", Code: joinCode})
		case "connect":
			peersLock.Lock()
			peer, ok := peers[msg.Code]
			peersLock.Unlock()
			if ok {
				peer.WriteJSON(Message{Type: "connected"})
				conn.WriteJSON(Message{Type: "connected"})
				peersLock.Lock()
				peers[msg.Code] = conn
				peersLock.Unlock()
			} else {
				conn.WriteJSON(Message{Type: "error", Content: "Invalid code"})
			}
		case "file":
			decrypted, err := decrypt(msg.Content)
			if err != nil {
				log.Println("Decryption error:", err)
				continue
			}
			peersLock.Lock()
			peer, ok := peers[msg.Code]
			peersLock.Unlock()
			if ok {
				peer.WriteJSON(Message{
					Type:    "file",
					Name:    msg.Name,
					Content: decrypted,
				})
			}
		}
	}

	if joinCode != "" {
		peersLock.Lock()
		delete(peers, joinCode)
		peersLock.Unlock()
	}
}

func generateJoinCode() string {
	counter++
	code, err := hotp.GenerateCode(hotpSecret, counter)
	if err != nil {
		log.Println("HOTP generation failed:", err)
		return "000000"
	}
	return code
}

func decrypt(cipherText string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(cipherText)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", err
	}
	if len(data) < aes.BlockSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	iv := data[:aes.BlockSize]
	data = data[aes.BlockSize:]
	stream := cipher.NewCFBDecrypter(block, iv)
	stream.XORKeyStream(data, data)
	return string(data), nil
}
