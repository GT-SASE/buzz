// Command server is the buzz backend: a stdlib net/http service that Vercel
// runs from sites/backend and that listens on $PORT.
package main

import (
	"cmp"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// version is the repo version. The build sets it:
// go build -ldflags "-X main.version=3.0.12" ./cmd/server
var version = "dev"

type build struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

// currentBuild mirrors sites/web/build-version.ts: the commit is the first 7
// characters of VERCEL_GIT_COMMIT_SHA.
func currentBuild() build {
	commit := os.Getenv("VERCEL_GIT_COMMIT_SHA")
	if len(commit) > 7 {
		commit = commit[:7]
	}
	return build{Version: version, Commit: commit}
}

func newMux(b build) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})
	mux.HandleFunc("GET /api/backend/version", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(b)
	})
	return mux
}

// run serves h on ln until ctx is cancelled, then drains in-flight requests.
func run(ctx context.Context, ln net.Listener, h http.Handler) error {
	srv := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	failed := make(chan error, 1)
	go func() { failed <- srv.Serve(ln) }()
	select {
	case err := <-failed:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := ":" + cmp.Or(os.Getenv("PORT"), "3001")
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
	if err != nil {
		slog.Error("listen failed", "addr", addr, "err", err)
		os.Exit(1)
	}
	slog.Info("listening", "addr", ln.Addr().String())
	if err := run(ctx, ln, newMux(currentBuild())); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
