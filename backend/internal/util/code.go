package util

import (
	"fmt"
	"time"

	"github.com/pquerna/otp/hotp"
)

var counter uint64 = uint64(time.Now().Unix())

func GenerateCode(secret string) string {
	counter++
	code, err := hotp.GenerateCode(secret, counter)
	if err != nil {
		return fmt.Sprintf("%06d", time.Now().Unix()%1000000)
	}
	return code
}
