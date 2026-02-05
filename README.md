# 📦 GoShare - Secure File Transfer

A beautiful, secure peer-to-peer file sharing application built with Go and vanilla JavaScript. Share files across devices using simple 6-digit codes with end-to-end encryption.

![GoShare](https://img.shields.io/badge/Go-1.21+-00ADD8?style=for-the-badge&logo=go)
![WebSocket](https://img.shields.io/badge/WebSocket-Realtime-green?style=for-the-badge)
![AES](https://img.shields.io/badge/Encryption-AES--CBC-red?style=for-the-badge)

## ✨ Features

- 🔐 **End-to-End Encryption** - All files and text encrypted with AES (CBC for files, GCM for text)
- 💬 **Encrypted Text Messages** - Send long encrypted text messages (up to 100,000 characters)
- 📋 **Easy Copy/Paste** - One-click copy and paste for text messages
- 💾 **Download Messages** - Save received messages as text files
- 📱 **QR Code Support** - Easy connection via QR code scanning
- 👥 **Multi-Receiver** - One sender can share with up to 10 receivers simultaneously
- 📦 **Multiple Files** - Send multiple files in a single session
- ⚡ **Parallel Chunks** - Fast transfer using chunked parallel processing
- 🎨 **Beautiful Dark UI** - Modern, responsive dark-themed interface
- 📊 **Real-time Progress** - Live transfer progress for each file
- 🔄 **Auto-Reconnect** - Automatic WebSocket reconnection
- 📝 **Activity Logging** - Detailed transfer logs
- 🌐 **Cross-Platform** - Works on any device with a modern browser

## 🚀 Quick Start

### Prerequisites

- Go 1.21 or higher
- Modern web browser with WebSocket support

### Installation

1. **Clone the repository**

```bash
git clone https://github.com/yourusername/goshare.git
cd goshare
```

2. **Install dependencies**

```bash
go mod download
```

3. **Create public directory**

```bash
mkdir -p public
mv index.html public/
```

4. **Run the server**

```bash
go run server.go
```

5. **Open in browser**

```
http://localhost:5050
```

## 📖 How to Use

### Receiving Files & Messages

1. Click **"Receive Files"** button
2. Share the 6-digit code or QR code with the sender
3. Wait for sender to connect
4. Switch between **Files** and **Messages** tabs to view transfers
5. Files will be automatically downloaded when transfer completes
6. Messages can be copied or downloaded as text files

### Sending Files

1. Click **"Send Files"** button
2. Enter the 6-digit code from receiver
3. Click **"Connect"** to establish connection
4. Go to **Files** tab
5. Select one or multiple files
6. Click **"Send Files"** to start transfer
7. Monitor progress in real-time

### Sending Text Messages

1. Click **"Send Files"** button (works for messages too)
2. Enter the 6-digit code from receiver
3. Click **"Connect"** to establish connection
4. Go to **Messages** tab
5. Type or paste your message (up to 100,000 characters)
6. Click **"Send Message"**
7. Message will be encrypted and sent to all connected receivers
8. Use the **Paste** button for quick clipboard paste
9. View sent messages in the message history
10. Copy or download messages using the action buttons

## 🏗️ Architecture

### Backend (Go)

- **WebSocket Server** - Handles real-time bidirectional communication
- **Session Management** - Manages active file sharing sessions
- **Multi-Receiver Broadcasting** - Efficiently broadcasts chunks to multiple receivers
- **HOTP Code Generation** - Secure 6-digit session codes
- **Automatic Cleanup** - Removes expired sessions

### Frontend (JavaScript)

- **Vanilla JS** - No frameworks, pure JavaScript
- **Web Crypto API** - Browser-native AES-CBC encryption
- **WebSocket Client** - Real-time communication
- **QR Code Generation** - Easy mobile connection
- **Responsive Design** - Works on all screen sizes

### Security

```
┌─────────┐                    ┌─────────┐                    ┌─────────┐
│ Sender  │                    │ Server  │                    │Receiver │
└────┬────┘                    └────┬────┘                    └────┬────┘
     │                              │                              │
     │  1. Read File                │                              │
     ├──────────────►               │                              │
     │  2. Split into Chunks        │                              │
     ├──────────────►               │                              │
     │  3. Encrypt Each Chunk (AES) │                              │
     ├──────────────►               │                              │
     │  4. Send Encrypted Chunk     │                              │
     ├─────────────────────────────►│  5. Broadcast to Receivers   │
     │                              ├─────────────────────────────►│
     │                              │                              │  6. Decrypt Chunk
     │                              │                              ├──────────────►
     │                              │                              │  7. Reassemble File
     │                              │                              ├──────────────►
     │                              │                              │  8. Download
     │                              │                              ├──────────────►
```

## 🔧 Configuration

### Server Configuration

Edit `server.go` constants:

```go
const (
    MaxReceivers     = 10                    // Maximum receivers per session
    MaxMessageSize   = 10 * 1024 * 1024     // 10MB max message size
    SessionTimeout   = 30 * time.Minute     // Session expiration time
    PingInterval     = 30 * time.Second     // WebSocket ping interval
)
```

### Client Configuration

Edit `index.html` JavaScript constants:

```javascript
const CHUNK_SIZE = 128 * 1024; // 128KB chunks
const PARALLEL_CHUNKS = 3; // Parallel chunk transfers
const ENCRYPTION_KEY = "..."; // 16-byte encryption key
```

## 📊 Performance

- **Chunk Size**: 128KB for optimal balance between speed and memory
- **Parallel Transfer**: 3 simultaneous chunks for faster throughput
- **Encryption**: AES-CBC with minimal overhead
- **Compression**: Not implemented (add gzip for text files if needed)

## 🔒 Security Considerations

### Current Implementation

✅ **Encrypted in Transit** - Files encrypted before sending  
✅ **Random Session Codes** - HOTP-based 6-digit codes  
✅ **Session Isolation** - Each session independent  
✅ **Auto Expiration** - Sessions expire after 30 minutes

### Recommended for Production

⚠️ **HTTPS/TLS** - Deploy behind reverse proxy with SSL  
⚠️ **Rate Limiting** - Add rate limits to prevent abuse  
⚠️ **Key Management** - Use environment variables for secrets  
⚠️ **Authentication** - Add optional user authentication  
⚠️ **File Size Limits** - Implement server-side file size validation  
⚠️ **Malware Scanning** - Scan files before transfer (optional)

## 🚀 Deployment

### Using Docker

```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY . .
RUN go mod download
RUN go build -o goshare server.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/goshare .
COPY --from=builder /app/public ./public
EXPOSE 5050
CMD ["./goshare"]
```

Build and run:

```bash
docker build -t goshare .
docker run -p 5050:5050 goshare
```

### Using Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl http2;
    server_name share.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 🐛 Troubleshooting

### WebSocket Connection Fails

- Check firewall settings
- Ensure port 5050 is accessible
- Verify WebSocket protocol (ws:// or wss://)

### Files Don't Download

- Check browser console for errors
- Verify all chunks received
- Ensure sufficient storage space
- Try smaller file sizes first

### Encryption Errors

- Verify encryption key length (must be 16 bytes)
- Check browser crypto API support
- Clear browser cache and retry

## 📝 API Reference

### WebSocket Messages

#### Client → Server

```json
// Register as receiver
{"type": "register"}

// Join existing session
{"type": "join", "code": "123456"}

// Connect as sender
{"type": "connect", "code": "123456"}

// Send file metadata
{
  "type": "metadata",
  "code": "123456",
  "name": "file.txt",
  "size": 1024,
  "totalChunks": 8,
  "fileId": "file_123",
  "fileIndex": 0,
  "totalFiles": 3
}

// Send chunk
{
  "type": "chunk",
  "code": "123456",
  "index": 0,
  "content": "base64data...",
  "fileId": "file_123"
}

// File complete
{
  "type": "done",
  "code": "123456",
  "name": "file.txt",
  "fileId": "file_123"
}

// All files sent
{"type": "all_done", "code": "123456"}

// Send encrypted text message
{
  "type": "text_message",
  "code": "123456",
  "text": "encrypted_base64_text...",
  "messageId": "msg_123"
}
```

#### Server → Client

```json
// Session code
{"type": "code", "code": "123456", "receiverId": "uuid"}

// Connection established
{"type": "connected", "receivers": 2}

// Receiver count update
{"type": "receiver_count", "receivers": 3}

// Text message received
{
  "type": "text_message",
  "text": "encrypted_base64_text...",
  "messageId": "msg_123",
  "timestamp": 1234567890
}

// Text message acknowledgment
{
  "type": "text_ack",
  "messageId": "msg_123",
  "receivers": 2
}

// Error
{"type": "error", "error": "Invalid code"}
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Gorilla WebSocket](https://github.com/gorilla/websocket) - WebSocket implementation
- [QRCode.js](https://github.com/davidshimjs/qrcodejs) - QR code generation
- [HOTP](https://github.com/pquerna/otp) - One-time password generation

## 📞 Support

If you encounter any issues or have questions:

- Open an issue on GitHub
- Check existing issues for solutions
- Review the troubleshooting section

---

Made with ❤️ by [Your Name]
