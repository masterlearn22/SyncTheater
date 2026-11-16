package main

import (
	"encoding/json"
	"time"
)

// RelaySignaling meneruskan paket SDP Offer, SDP Answer, dan ICE Candidate antar peer di room yang sama
func (h *RoomHub) RelaySignaling(sender *Client, payload map[string]interface{}) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	room, exists := h.Rooms[sender.RoomID]
	if !exists {
		return
	}

	payload["senderPeerId"] = sender.PeerID
	payload["senderRole"] = sender.Role
	payload["serverTimestamp"] = time.Now().UnixMilli()

	targetPeerID, _ := payload["targetPeerId"].(string)
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}

	for client := range room.Clients {
		if client == sender {
			continue
		}
		if targetPeerID != "" && client.PeerID != targetPeerID {
			continue
		}
		select {
		case client.Send <- encoded:
		default:
		}
	}
}
