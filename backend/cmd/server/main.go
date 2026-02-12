package main

import (
	"GoShare/internal/config"
	"GoShare/internal/server"
	"fmt"
	"log"
	"net/http"
)

func main() {
	cfg := config.Load()

	s := server.New(cfg)

	addr := ":" + cfg.Port
	fmt.Println("🚀 Server running on", addr)

	log.Fatal(http.ListenAndServe(addr, s.Router()))
}
