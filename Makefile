APP_NAME := goshare
BACKEND := backend
WEB := web
DIST := dist

.PHONY: all web backend build run clean

all: build

# ─────────────────────────────
# Frontend
# ─────────────────────────────
web:
	cd $(WEB) && npm install
	cd $(WEB) && npm run build
	# CHANGED: Clean the specific target directory inside internal/server
	rm -rf $(BACKEND)/internal/server/web
	mkdir -p $(BACKEND)/internal/server/web
	# CHANGED: Copy dist contents to internal/server/web
	cp -r $(WEB)/dist/* $(BACKEND)/internal/server/web/

# ─────────────────────────────
# Backend
# ─────────────────────────────
backend:
	cd $(BACKEND) && go mod tidy

# ─────────────────────────────
# Build everything
# ─────────────────────────────
build: web backend
	mkdir -p $(DIST)
	cd $(BACKEND) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
		go build -o ../$(DIST)/$(APP_NAME) ./cmd/server

# ─────────────────────────────
# Run locally
# ─────────────────────────────
run: build
	cd backend && ../$(DIST)/$(APP_NAME)

# ─────────────────────────────
# Cleanup
# ─────────────────────────────
clean:
	rm -rf $(DIST)
	rm -rf $(BACKEND)/internal/server/web

