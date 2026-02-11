package session

import (
	"GoShare/internal/protocol"
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Peer struct {
	ID   string
	Conn *websocket.Conn
	mu   sync.Mutex
}

func (p *Peer) Send(b []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Conn.WriteMessage(1, b)
}

type Session struct {
	Code         string
	Sender       *Peer
	Receivers    map[string]*Peer
	LastActivity time.Time
	mu           sync.RWMutex
}

type Manager struct {
	sessions map[string]*Session
	mu       sync.RWMutex
}

func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
	}
}

func (m *Manager) Create(code string, sender *Peer) *Session {
	s := &Session{
		Code:         code,
		Sender:       sender,
		Receivers:    make(map[string]*Peer),
		LastActivity: time.Now(),
	}
	m.mu.Lock()
	m.sessions[code] = s
	m.mu.Unlock()
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
}

func (s *Session) RouteSignal(msg protocol.Message) {
	bytes, _ := json.Marshal(msg)

	s.mu.RLock()
	defer s.mu.RUnlock()

	// To sender
	if s.Sender != nil && msg.TargetID == s.Sender.ID {
		s.Sender.mu.Lock()
		s.Sender.Conn.WriteMessage(1, bytes)
		s.Sender.mu.Unlock()
		return
	}

	// To receiver
	if peer, ok := s.Receivers[msg.TargetID]; ok {
		peer.mu.Lock()
		peer.Conn.WriteMessage(1, bytes)
		peer.mu.Unlock()
	}
}

func (s *Session) AddReceiver(p *Peer) {
	s.mu.Lock()
	s.Receivers[p.ID] = p
	s.LastActivity = time.Now()
	s.mu.Unlock()
}

func (s *Session) NotifySenderReceiverJoined(id string) {
	msg, _ := json.Marshal(map[string]any{
		"type":     "receiver_joined",
		"targetId": id,
	})

	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.Sender != nil {
		s.Sender.Send(msg)
	}
}

func (s *Session) RelayTextFromSender(b []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.Receivers {
		r.Send(b)
	}
}

func (s *Session) RelayTextToSender(b []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.Sender != nil {
		s.Sender.Send(b)
	}
}
