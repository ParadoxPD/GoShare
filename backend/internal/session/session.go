package session

import (
	"GoShare/internal/protocol"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Peer struct {
	ID   string
	Conn *websocket.Conn
	mu   sync.Mutex
}

func (p *Peer) Send(b []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.Conn == nil {
		return websocket.ErrCloseSent
	}

	// IMPROVED: Set write deadline
	p.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return p.Conn.WriteMessage(websocket.TextMessage, b)
}

func (p *Peer) SafeSend(b []byte) bool {
	err := p.Send(b)
	if err != nil {
		log.Printf("⚠️ Failed to send to peer %s: %v", p.ID, err)
		return false
	}
	return true
}

type Session struct {
	Code         string
	Sender       *Peer
	Receivers    map[string]*Peer
	LastActivity time.Time
	CreatedAt    time.Time
	mu           sync.RWMutex
}

type Manager struct {
	sessions map[string]*Session
	mu       sync.RWMutex
}

func NewManager() *Manager {
	m := &Manager{
		sessions: make(map[string]*Session),
	}

	// IMPROVED: Start cleanup goroutine
	go m.cleanupLoop()

	return m
}

func (m *Manager) Create(code string, sender *Peer) *Session {
	s := &Session{
		Code:         code,
		Sender:       sender,
		Receivers:    make(map[string]*Peer),
		LastActivity: time.Now(),
		CreatedAt:    time.Now(),
	}
	m.mu.Lock()
	m.sessions[code] = s
	m.mu.Unlock()

	log.Printf("📦 Created session %s (total sessions: %d)", code, m.Count())
	return s
}

func (m *Manager) Get(code string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[code]
	return s, ok
}

func (m *Manager) Delete(code string) {
	m.mu.Lock()
	delete(m.sessions, code)
	m.mu.Unlock()

	log.Printf("🗑️ Deleted session %s (total sessions: %d)", code, m.Count())
}

func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

// IMPROVED: Cleanup stale sessions
func (m *Manager) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		m.cleanup()
	}
}

func (m *Manager) cleanup() {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	staleTimeout := 30 * time.Minute

	for code, sess := range m.sessions {
		sess.mu.RLock()
		age := now.Sub(sess.LastActivity)
		sess.mu.RUnlock()

		if age > staleTimeout {
			log.Printf("🧹 Cleaning up stale session %s (inactive for %v)", code, age)
			delete(m.sessions, code)
		}
	}
}

func (s *Session) RouteSignal(msg protocol.Message) {
	bytes, _ := json.Marshal(msg)

	s.mu.RLock()
	defer s.mu.RUnlock()

	// Update activity
	s.LastActivity = time.Now()

	// To sender
	if s.Sender != nil && msg.TargetID == s.Sender.ID {
		s.Sender.SafeSend(bytes)
		return
	}

	// To receiver
	if peer, ok := s.Receivers[msg.TargetID]; ok {
		peer.SafeSend(bytes)
	} else {
		log.Printf("⚠️ Signal target %s not found in session %s", msg.TargetID, s.Code)
	}
}

func (s *Session) AddReceiver(p *Peer) {
	s.mu.Lock()
	s.Receivers[p.ID] = p
	s.LastActivity = time.Now()
	receiverCount := len(s.Receivers)
	s.mu.Unlock()

	log.Printf("➕ Added receiver %s to session %s (total: %d)", p.ID, s.Code, receiverCount)

	// IMPROVED: Notify sender of receiver count
	s.notifySenderReceiverCount()
}

// IMPROVED: Remove receiver and notify
func (s *Session) RemoveReceiver(id string) {
	s.mu.Lock()
	delete(s.Receivers, id)
	receiverCount := len(s.Receivers)
	s.mu.Unlock()

	log.Printf("➖ Removed receiver %s from session %s (remaining: %d)", id, s.Code, receiverCount)

	// Notify sender of updated count
	s.notifySenderReceiverCount()
}

func (s *Session) NotifySenderReceiverJoined(id string) {
	msg, _ := json.Marshal(map[string]any{
		"type":     "receiver_joined",
		"targetId": id,
	})

	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.Sender != nil {
		s.Sender.SafeSend(msg)
	}
}

// IMPROVED: Notify sender of receiver count
func (s *Session) notifySenderReceiverCount() {
	s.mu.RLock()
	count := len(s.Receivers)
	sender := s.Sender
	s.mu.RUnlock()

	if sender != nil {
		msg, _ := json.Marshal(map[string]any{
			"type":      "receiver_count",
			"receivers": count,
		})
		sender.SafeSend(msg)
	}
}

// IMPROVED: Notify receivers that sender disconnected
func (s *Session) NotifyReceiversSenderDisconnected() {
	msg, _ := json.Marshal(map[string]any{
		"type": "sender_disconnected",
	})

	s.mu.RLock()
	receivers := make([]*Peer, 0, len(s.Receivers))
	for _, r := range s.Receivers {
		receivers = append(receivers, r)
	}
	s.mu.RUnlock()

	for _, r := range receivers {
		r.SafeSend(msg)
	}

	log.Printf("📢 Notified %d receivers that sender disconnected from session %s", len(receivers), s.Code)
}

func (s *Session) RelayTextFromSender(b []byte) int {
	s.mu.RLock()
	receivers := make([]*Peer, 0, len(s.Receivers))
	for _, r := range s.Receivers {
		receivers = append(receivers, r)
	}
	s.mu.RUnlock()

	count := 0
	for _, r := range receivers {
		if r.SafeSend(b) {
			count++
		}
	}
	return count
}

func (s *Session) RelayTextToSender(b []byte) {
	s.mu.RLock()
	sender := s.Sender
	s.mu.RUnlock()

	if sender != nil {
		sender.SafeSend(b)
	}
}
