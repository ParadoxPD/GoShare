package server

import (
	"GoShare/internal/config"
	"GoShare/internal/protocol"
	"GoShare/internal/session"
	"GoShare/internal/util"
	"GoShare/internal/ws"
	"embed"
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

//go:embed web
var webFS embed.FS

type Server struct {
	sessions *session.Manager
	upgrader websocket.Upgrader
	cfg      *config.Config
}

func New(cfg *config.Config) *Server {
	return &Server{
		sessions: session.NewManager(),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// IMPROVED: Log origin for debugging
				origin := r.Header.Get("Origin")
				log.Printf("WebSocket connection from origin: %s", origin)
				return true // Allow all origins in development
			},
			// IMPROVED: Set buffer sizes
			ReadBufferSize:  1024 * 4,  // 4KB
			WriteBufferSize: 1024 * 16, // 16KB
			// IMPROVED: Enable compression
			EnableCompression: true,
		},
		cfg: cfg,
	}
}

func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", s.handleHealth)

	// Get the subdirectory inside the embedded FS
	dist, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal("Failed to embed web assets:", err)
	}

	fileServer := http.FileServer(http.FS(dist))

	// CHANGED: Use a closure to handle SPA routing (fallback to index.html)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Check if file exists in the embedded FS
		f, err := dist.Open(r.URL.Path[1:]) // trim leading slash
		if err == nil {
			// File exists (e.g., assets/index.js), serve it
			defer f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// File not found? It might be a client-side route.
		// Serve index.html instead.
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})

	return corsMiddleware(mux)
}

// IMPROVED: Add CORS middleware
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	response := map[string]any{
		"status":   "healthy",
		"time":     time.Now().Unix(),
		"sessions": s.sessions.Count(),
	}

	json.NewEncoder(w).Encode(response)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// IMPROVED: Log connection attempt
	log.Printf("New WebSocket connection attempt from %s", r.RemoteAddr)

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("❌ Failed to upgrade connection: %v", err)
		return
	}

	// IMPROVED: Log successful upgrade
	log.Printf("✅ WebSocket connection upgraded for %s", r.RemoteAddr)

	done := make(chan struct{})
	ws.StartHeartbeat(conn, done)

	defer func() {
		close(done)
		conn.Close()
		log.Printf("🔌 WebSocket connection closed for %s", r.RemoteAddr)
	}()

	peer := &session.Peer{
		ID:   uuid.New().String(),
		Conn: conn,
	}

	log.Printf("👤 Created peer with ID: %s", peer.ID)

	var currentSession *session.Session
	var isSender bool
	var writeMu sync.Mutex

	// IMPROVED: Set read deadline
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))

	// IMPROVED: Set pong handler to reset deadline
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNormalClosure) {
				log.Printf("⚠️ Unexpected close error for %s: %v", peer.ID, err)
			} else {
				log.Printf("📭 Connection closed for %s: %v", peer.ID, err)
			}

			// IMPROVED: Cleanup session on disconnect
			if currentSession != nil {
				if isSender {
					log.Printf("🚪 Sender %s disconnected from session %s", peer.ID, currentSession.Code)
					// Notify receivers
					currentSession.NotifyReceiversSenderDisconnected()
				} else {
					log.Printf("🚪 Receiver %s disconnected from session %s", peer.ID, currentSession.Code)
					currentSession.RemoveReceiver(peer.ID)
				}
			}
			return
		}

		// IMPROVED: Reset read deadline on each message
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var msg protocol.Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("⚠️ Failed to parse message from %s: %v", peer.ID, err)
			ws.SafeWrite(conn, &writeMu, mustJSON(protocol.Message{
				Type:  "error",
				Error: "Invalid message format",
			}))
			continue
		}

		// IMPROVED: Log message type
		log.Printf("📨 Received %s message from %s", msg.Type, peer.ID)

		switch msg.Type {

		// ─────────────────────────────
		// CREATE SESSION (sender)
		// ─────────────────────────────
		case "create_session":
			code := util.GenerateCode(base64.StdEncoding.EncodeToString(s.cfg.HOTPSecret))
			currentSession = s.sessions.Create(code, peer)
			isSender = true

			log.Printf("🎫 Created session %s for sender %s", code, peer.ID)

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
			if msg.Code == "" {
				ws.SafeWrite(conn, &writeMu, mustJSON(protocol.Message{
					Type:  "error",
					Error: "Session code is required",
				}))
				continue
			}

			sess, ok := s.sessions.Get(msg.Code)
			if !ok {
				log.Printf("⚠️ Invalid session code attempted: %s from %s", msg.Code, peer.ID)
				ws.SafeWrite(conn, &writeMu, mustJSON(protocol.Message{
					Type:  "error",
					Error: "Invalid session code",
				}))
				continue
			}

			// IMPROVED: Check max receivers
			if len(sess.Receivers) >= s.cfg.MaxReceivers {
				log.Printf("⚠️ Session %s is full (max %d receivers)", msg.Code, s.cfg.MaxReceivers)
				ws.SafeWrite(conn, &writeMu, mustJSON(protocol.Message{
					Type:  "error",
					Error: "Session is full",
				}))
				continue
			}

			sess.AddReceiver(peer)
			currentSession = sess

			log.Printf("✅ Receiver %s joined session %s", peer.ID, msg.Code)

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
			if currentSession == nil {
				log.Printf("⚠️ WebRTC signal from %s without session", peer.ID)
				ws.SafeWrite(conn, &writeMu, mustJSON(protocol.Message{
					Type:  "error",
					Error: "No active session",
				}))
				continue
			}

			// Determine signal type for better logging
			signalType := "unknown"
			var signalData map[string]interface{}
			if err := json.Unmarshal(msg.Signal, &signalData); err == nil {
				if st, ok := signalData["type"].(string); ok {
					signalType = st
				}
			}

			log.Printf("📡 Routing WebRTC %s signal: %s → %s (session %s)",
				signalType, msg.FromID, msg.TargetID, currentSession.Code)

			currentSession.RouteSignal(msg)

			log.Printf("✅ Signal relayed successfully")
		// ─────────────────────────────
		// TEXT CHAT RELAY
		// ─────────────────────────────
		case "text_message":
			if currentSession == nil {
				log.Printf("⚠️ Text message from %s without session", peer.ID)
				continue
			}

			msg.Timestamp = time.Now().Unix()
			bytes := mustJSON(msg)

			if isSender {
				count := currentSession.RelayTextFromSender(bytes)
				log.Printf("💬 Relayed message from sender to %d receivers", count)
			} else {
				currentSession.RelayTextToSender(bytes)
				log.Printf("💬 Relayed message from receiver to sender")
			}

		// ─────────────────────────────
		// PING/PONG HEARTBEAT
		// ─────────────────────────────
		case "ping":
			// Respond with pong containing the original timestamp
			var pingTime int64
			if msg.Timestamp > 0 {
				pingTime = msg.Timestamp
			} else {
				pingTime = time.Now().Unix()
			}

			ws.SafeWrite(conn, &writeMu, mustJSON(protocol.Message{
				Type:      "pong",
				Timestamp: pingTime,
			}))
		default:
			log.Printf("⚠️ Unknown message type: %s from %s", msg.Type, peer.ID)
		}
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("❌ Failed to marshal JSON: %v", err)
		return []byte("{}")
	}
	return b
}
