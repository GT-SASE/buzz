package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
	return rec
}

func TestVersion(t *testing.T) {
	rec := get(t, newMux(build{Version: "3.0.12", Commit: "abc1234"}), "/api/backend/version")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	var got build
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if want := (build{Version: "3.0.12", Commit: "abc1234"}); got != want {
		t.Fatalf("body = %+v, want %+v", got, want)
	}
}

func TestHealthz(t *testing.T) {
	rec := get(t, newMux(build{}), "/healthz")
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("got %d %q, want 200 \"ok\"", rec.Code, rec.Body.String())
	}
}

func TestCurrentBuildShortensCommit(t *testing.T) {
	t.Setenv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef")
	if got := currentBuild().Commit; got != "0123456" {
		t.Fatalf("commit = %q, want 0123456", got)
	}
}

// A request that is in flight when the context is cancelled still gets its
// answer, and run then returns nil.
func TestRunShutsDownGracefully(t *testing.T) {
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	inFlight := make(chan struct{})
	release := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(inFlight)
		<-release
		_, _ = io.WriteString(w, "done")
	})
	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan error, 1)
	go func() { stopped <- run(ctx, ln, h) }()

	body := make(chan string, 1)
	go func() {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+ln.Addr().String(), nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			body <- err.Error()
			return
		}
		b, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		body <- string(b)
	}()

	<-inFlight
	cancel()
	select {
	case err := <-stopped:
		t.Fatalf("run returned %v while a request was in flight", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if got := <-body; got != "done" {
		t.Fatalf("response = %q, want done", got)
	}
	if err := <-stopped; err != nil {
		t.Fatalf("run = %v, want nil", err)
	}
}
