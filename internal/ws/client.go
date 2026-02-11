package ws

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	WriteTimeout = 10 * time.Second
	PingInterval = 20 * time.Second
)

func StartHeartbeat(conn *websocket.Conn, done chan struct{}) {
	ticker := time.NewTicker(PingInterval)
	go func() {
		for {
			select {
			case <-ticker.C:
				conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(WriteTimeout))
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()
}

func SafeWrite(conn *websocket.Conn, mu *sync.Mutex, msg []byte) error {
	mu.Lock()
	defer mu.Unlock()
	conn.SetWriteDeadline(time.Now().Add(WriteTimeout))
	return conn.WriteMessage(websocket.TextMessage, msg)
}
