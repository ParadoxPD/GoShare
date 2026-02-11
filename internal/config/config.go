package config

import (
	"encoding/base64"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	EncryptionKey  []byte
	HOTPSecret     []byte
	MaxReceivers   int
	SessionTimeout time.Duration
	Port           string
}

func Load() *Config {
	_ = godotenv.Load()

	cfg := &Config{
		EncryptionKey:  mustDecode("GOSHARE_ENCRYPTION_KEY", 16),
		HOTPSecret:     mustDecode("GOSHARE_HOTP_SECRET", 32),
		MaxReceivers:   mustInt("GOSHARE_MAX_RECEIVERS", 10),
		SessionTimeout: mustDuration("GOSHARE_SESSION_TIMEOUT", 30*time.Minute),
		Port:           mustString("PORT", "4000"),
	}

	return cfg
}

func mustDecode(env string, expected int) []byte {
	val := mustString(env, "")
	data, err := base64.StdEncoding.DecodeString(val)
	if err != nil {
		log.Fatalf("%s must be base64: %v", env, err)
	}
	if len(data) != expected {
		log.Fatalf("%s must be %d bytes, got %d", env, expected, len(data))
	}
	return data
}

func mustInt(env string, def int) int {
	val := os.Getenv(env)
	if val == "" {
		return def
	}
	i, err := strconv.Atoi(val)
	if err != nil {
		log.Fatalf("%s must be int", env)
	}
	return i
}

func mustDuration(env string, def time.Duration) time.Duration {
	val := os.Getenv(env)
	if val == "" {
		return def
	}
	d, err := time.ParseDuration(val)
	if err != nil {
		log.Fatalf("%s invalid duration", env)
	}
	return d
}

func mustString(env, def string) string {
	val := os.Getenv(env)
	if val == "" {
		if def == "" {
			log.Fatalf("%s is required", env)
		}
		return def
	}
	return val
}
