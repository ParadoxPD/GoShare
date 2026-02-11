package protocol

import "encoding/json"

type Message struct {
	Type string `json:"type"`

	Code string `json:"code,omitempty"`

	// identity
	FromID     string `json:"fromId,omitempty"`
	TargetID   string `json:"targetId,omitempty"`
	ReceiverID string `json:"receiverId,omitempty"`

	// chat
	Text       string `json:"text,omitempty"`
	MessageID  string `json:"messageId,omitempty"`
	Timestamp  int64  `json:"timestamp,omitempty"`
	SenderName string `json:"senderName,omitempty"`

	// webrtc
	Signal json.RawMessage `json:"signal,omitempty"`

	// misc
	Error string `json:"error,omitempty"`
}
