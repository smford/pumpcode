package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestOAuthTokenRetrievalAndCache(t *testing.T) {
	var requestCount int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)

		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var payload struct {
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("failed to decode json body: %v", err)
		}

		if payload.ClientID != "test-client-id" {
			t.Errorf("expected client_id=test-client-id, got %s", payload.ClientID)
		}
		if payload.ClientSecret != "test-client-secret" {
			t.Errorf("expected client_secret=test-client-secret, got %s", payload.ClientSecret)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(OAuthTokenResponse{
			AccessToken: "test-access-token-12345",
			TokenType:   "Bearer",
			ExpiresIn:   3600,
		})
	}))
	defer server.Close()

	c := NewClient(Config{
		ClientID:     "test-client-id",
		ClientSecret: "test-client-secret",
		TokenURL:     server.URL,
	})

	ctx := context.Background()

	// First call should make an HTTP request
	tok1, err := c.GetToken(ctx)
	if err != nil {
		t.Fatalf("GetToken failed: %v", err)
	}
	if tok1 != "test-access-token-12345" {
		t.Errorf("expected token test-access-token-12345, got %s", tok1)
	}

	// Second call should return cached token without HTTP request
	tok2, err := c.GetToken(ctx)
	if err != nil {
		t.Fatalf("GetToken 2nd call failed: %v", err)
	}
	if tok2 != "test-access-token-12345" {
		t.Errorf("expected token test-access-token-12345, got %s", tok2)
	}

	if count := atomic.LoadInt32(&requestCount); count != 1 {
		t.Errorf("expected 1 HTTP request due to caching, got %d", count)
	}
}

func TestRetryOnTransientServerError(t *testing.T) {
	var attempts int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := atomic.AddInt32(&attempts, 1)
		if current < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error": "temporarily unavailable"}`))
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"stations": []map[string]interface{}{
				{
					"site_id":  "st-01",
					"brand":    "Tesco",
					"postcode": "SS1 2EF",
					"latitude": 51.54,
					"longitude": 0.71,
					"prices": map[string]float64{
						"E10": 137.9,
						"B7":  142.9,
					},
				},
			},
		})
	}))
	defer server.Close()

	c := NewClient(Config{
		ClientID:         "test-client",
		ClientSecret:     "test-secret",
		TokenURL:         server.URL,
		BaseURL:          server.URL,
		StationsEndpoint: "/stations",
		MaxRetries:       4,
	})

	// Pre-populate token to focus test on station fetching retry
	c.accessToken = "pre-cached-token"
	c.expiresAt = time.Now().Add(1 * time.Hour)

	stations, err := c.FetchStations(context.Background())
	if err != nil {
		t.Fatalf("FetchStations should have succeeded after retries: %v", err)
	}

	if len(stations) != 1 {
		t.Fatalf("expected 1 station, got %d", len(stations))
	}

	if attempts != 3 {
		t.Errorf("expected 3 attempts before success, got %d", attempts)
	}
}

func TestParseStationsJSONVariations(t *testing.T) {
	jsonPayload := []byte(`{
		"stations": [
			{
				"id": "st-1",
				"brand": "BP",
				"name": "BP Southend",
				"postcode": "SS1 1AA",
				"lat": 51.54,
				"lon": 0.71,
				"prices": {
					"E10": 139.9,
					"B7": 145.9
				},
				"amenities": ["shop", "car_wash"]
			},
			{
				"site_id": "st-2",
				"brand": "Shell",
				"address": "123 Westminster Way",
				"postcode": "SW1A 1AA",
				"location": {
					"latitude": 51.50,
					"longitude": -0.14
				},
				"prices": [
					{"fuel_type": "E10", "price": 142.9},
					{"fuel_type": "B7", "price": "148.9"}
				]
			}
		]
	}`)

	stations, err := parseStationsJSON(jsonPayload)
	if err != nil {
		t.Fatalf("parseStationsJSON failed: %v", err)
	}

	if len(stations) != 2 {
		t.Fatalf("expected 2 stations, got %d", len(stations))
	}

	st1 := stations[0]
	if st1.Brand != "BP" || st1.Postcode != "SS1 1AA" || st1.Prices["E10"] != 139.9 {
		t.Errorf("station 1 mismatch: %+v", st1)
	}

	st2 := stations[1]
	if st2.ID != "st-2" || st2.Name != "123 Westminster Way" || st2.Lat != 51.50 || st2.Prices["B7"] != 148.9 {
		t.Errorf("station 2 mismatch: %+v", st2)
	}
}

func TestMockStationsFallback(t *testing.T) {
	c := NewClient(Config{})
	stations, err := c.FetchStations(context.Background())
	if err != nil {
		t.Fatalf("FetchStations without credentials failed: %v", err)
	}
	if len(stations) == 0 {
		t.Fatalf("expected mock stations when credentials missing")
	}
}
