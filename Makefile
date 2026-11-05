.PHONY: all run-pipeline test serve-local clean

all: test run-pipeline

run-pipeline:
	go run ./cmd/pipeline/main.go

test:
	go test -v ./...

serve-local:
	go run ./cmd/pipeline/main.go -serve :8080

clean:
	rm -rf data/outcodes
