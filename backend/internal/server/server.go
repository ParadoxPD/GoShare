package server

import (
	"GoShare/internal/config"
	"GoShare/internal/protocol"
	"GoShare/internal/session"
	"GoShare/internal/util"
	"GoShare/internal/ws"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type Server struct {
	sessions *session.Manager
	upgrader websocket.Upgrader
	cfg      *config.Config
}

func New(cfg *config.Config) *Server {
	return &Server{
		sessions: session.NewManager(),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		cfg: cfg,
	}
}

func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
	return mux
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	done := make(chan struct{})
	ws.StartHeartbeat(conn, done)

	defer func() {
		close(done)
		conn.Close()
	}()

	peer := &session.Peer{
		ID:   uuid.New().String(),
		Conn: conn,
	}

	var currentSession *session.Session
	var isSender bool
	var writeMu sync.Mutex

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			log.Println("read error:", err)
			return
		}

		var msg protocol.Message
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		switch msg.Type {

		// ─────────────────────────────
		// CREATE SESSION (sender)
		// ─────────────────────────────
		case "create_session":
			code := util.GenerateCode(base64.StdEncoding.EncodeToString(s.cfg.HOTPSecret))
			currentSession = s.sessions.Create(code, peer)
			isSender = true

			resp := protocol.Message{
				Type:   "code",
				Code:   code,
				FromID: peer.ID,
			}
			bytes, _ := json.Marshal(resp)
			ws.SafeWrite(conn, &writeMu, bytes)

		// ─────────────────────────────
		// JOIN SESSION (receiver)
		// ─────────────────────────────
		case "join":
			sess, ok := s.sessions.Get(msg.Code)
			if !ok {
				ws.SafeWrite(conn, &writeMu, mustJSON(protocol.Message{
					Type:  "error",
					Error: "invalid code",
				}))
				continue
			}

			sess.AddReceiver(peer)
			currentSession = sess

			ws.SafeWrite(conn, &writeMu, mustJSON(protocol.Message{
				Type:       "joined",
				Code:       msg.Code,
				ReceiverID: peer.ID,
				FromID:     sess.Sender.ID,
			}))

			sess.NotifySenderReceiverJoined(peer.ID)

		// ─────────────────────────────
		// WEBRTC SIGNAL RELAY
		// ─────────────────────────────
		case "webrtc_signal":
			if currentSession != nil {
				currentSession.RouteSignal(msg)
			}

			// ─────────────────────────────
			// TEXT CHAT RELAY
			// ─────────────────────────────
		case "text_message":
			if currentSession == nil {
				continue
			}

			msg.Timestamp = time.Now().Unix()
			bytes := mustJSON(msg)

			if isSender {
				currentSession.RelayTextFromSender(bytes)
			} else {
				currentSession.RelayTextToSender(bytes)
			}
		}
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
