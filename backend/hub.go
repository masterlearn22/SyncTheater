package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// SyncState menyimpan posisi pemutaran terkini di memori per room
type SyncState struct {
	Type            string  `json:"type"`
	SenderRole      string  `json:"senderRole"`
	Action          string  `json:"action"` // PLAY | PAUSE | SEEK | HEARTBEAT | MEDIA_CHANGE
	VideoTime       float64 `json:"videoTime"`
	ServerTimestamp int64   `json:"serverTimestamp"`
	PlaybackRate    float64 `json:"playbackRate"`
	MediaSource     string  `json:"mediaSource,omitempty"`
	IsPlaying       bool    `json:"isPlaying"`
}

type Client struct {
	Hub    *RoomHub
	Conn   *websocket.Conn
	Send   chan []byte
	RoomID string
	Role   string // HOST | GUEST
	PeerID string
}

type Room struct {
	ID        string
	Clients   map[*Client]bool
	LastState *SyncState
}

type RoomHub struct {
	mu         sync.RWMutex
	Rooms      map[string]*Room
	Register   chan *Client
	Unregister chan *Client
	Broadcast  chan InboundMessage
}

type InboundMessage struct {
	Sender  *Client
	Payload []byte
}

func NewRoomHub() *RoomHub {
	return &RoomHub{
		Rooms:      make(map[string]*Room),
		Register:   make(chan *Client),
		Unregister: make(chan *Client),
		Broadcast:  make(chan InboundMessage, 256),
	}
}

func (h *RoomHub) Run() {
	for {
		select {
		case client := <-h.Register:
			h.mu.Lock()
			room, exists := h.Rooms[client.RoomID]
			if !exists {
				room = &Room{
					ID:      client.RoomID,
					Clients: make(map[*Client]bool),
					LastState: &SyncState{
						Type:            "SYNC_STATE",
						SenderRole:      "HOST",
						Action:          "PAUSE",
						VideoTime:       0,
						ServerTimestamp: time.Now().UnixMilli(),
						PlaybackRate:    1.0,
						IsPlaying:       false,
					},
				}
				h.Rooms[client.RoomID] = room
			}
			room.Clients[client] = true
			var initialState *SyncState
			if room.LastState != nil {
				copied := *room.LastState
				initialState = &copied
			}
			h.mu.Unlock()

			log.Printf("[Hub] Client bergabung ke room '%s' sebagai %s (PeerID: %s)", client.RoomID, client.Role, client.PeerID)

			// Kirim state terakhir ke klien yang baru bergabung / refresh
			if initialState != nil {
				if initialState.IsPlaying {
					elapsedSec := float64(time.Now().UnixMilli()-initialState.ServerTimestamp) / 1000.0
					initialState.VideoTime += elapsedSec * initialState.PlaybackRate
					initialState.ServerTimestamp = time.Now().UnixMilli()
				}
				if raw, err := json.Marshal(initialState); err == nil {
					select {
					case client.Send <- raw:
					default:
					}
				}
			}

			// Beritahu semua anggota room jumlah peserta aktif
			h.broadcastPresence(client.RoomID)

		case client := <-h.Unregister:
			h.mu.Lock()
			if room, exists := h.Rooms[client.RoomID]; exists {
				if _, ok := room.Clients[client]; ok {
					delete(room.Clients, client)
					close(client.Send)
					if len(room.Clients) == 0 {
						delete(h.Rooms, client.RoomID)
					}
				}
			}
			h.mu.Unlock()
			h.broadcastPresence(client.RoomID)

		case msg := <-h.Broadcast:
			h.handleMessage(msg.Sender, msg.Payload)
		}
	}
}

func (h *RoomHub) broadcastPresence(roomID string) {
	h.mu.RLock()
	room, exists := h.Rooms[roomID]
	if !exists {
		h.mu.RUnlock()
		return
	}
	peers := make([]map[string]string, 0, len(room.Clients))
	for c := range room.Clients {
		peers = append(peers, map[string]string{
			"peerId": c.PeerID,
			"role":   c.Role,
		})
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"type":            "ROOM_PRESENCE",
		"roomId":          roomID,
		"peers":           peers,
		"serverTimestamp": time.Now().UnixMilli(),
	})
	for c := range room.Clients {
		select {
		case c.Send <- payload:
		default:
		}
	}
	h.mu.RUnlock()
}

func (h *RoomHub) handleMessage(sender *Client, raw []byte) {
	var base map[string]interface{}
	if err := json.Unmarshal(raw, &base); err != nil {
		return
	}

	msgType, _ := base["type"].(string)
	nowMs := time.Now().UnixMilli()

	switch msgType {
	case "PING":
		// Kalibrasi NTP-Lite: langsung balas PONG ke pengirim dengan serverTimestamp presisi
		pong := map[string]interface{}{
			"type":            "PONG",
			"seq":             base["seq"],
			"clientSentTime":  base["clientSentTime"],
			"serverTimestamp": nowMs,
		}
		if resp, err := json.Marshal(pong); err == nil {
			select {
			case sender.Send <- resp:
			default:
			}
		}

	case "SYNC_STATE":
		var state SyncState
		if err := json.Unmarshal(raw, &state); err != nil {
			return
		}
		state.ServerTimestamp = nowMs
		state.SenderRole = sender.Role
		if state.PlaybackRate == 0 {
			state.PlaybackRate = 1.0
		}
		if state.Action == "PLAY" {
			state.IsPlaying = true
		} else if state.Action == "PAUSE" {
			state.IsPlaying = false
		}

		h.mu.Lock()
		room, exists := h.Rooms[sender.RoomID]
		if exists {
			room.LastState = &state
			updatedRaw, _ := json.Marshal(state)
			for c := range room.Clients {
				if c != sender {
					select {
					case c.Send <- updatedRaw:
					default:
					}
				}
			}
		}
		h.mu.Unlock()

	case "WEBRTC_SIGNAL":
		// Diteruskan melalui modul signaling.go
		h.RelaySignaling(sender, base)
	}
}

func ServeWs(hub *RoomHub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] Upgrade error: %v", err)
		return
	}

	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		roomID = "cinema-1"
	}
	role := r.URL.Query().Get("role")
	if role == "" {
		role = "GUEST"
	}
	peerID := r.URL.Query().Get("peerId")
	if peerID == "" {
		peerID = role + "-" + time.Now().Format("150405")
	}

	client := &Client{
		Hub:    hub,
		Conn:   conn,
		Send:   make(chan []byte, 128),
		RoomID: roomID,
		Role:   role,
		PeerID: peerID,
	}

	hub.Register <- client

	go client.writePump()
	go client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		c.Hub.Unregister <- c
		c.Conn.Close()
	}()
	c.Conn.SetReadLimit(65536)
	_ = c.Conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.Conn.SetPongHandler(func(string) error {
		_ = c.Conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})
	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			break
		}
		c.Hub.Broadcast <- InboundMessage{Sender: c, Payload: message}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
