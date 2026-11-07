package sharding

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Station represents a standardized UK filling station record.
type Station struct {
	ID        string             `json:"id"`
	Brand     string             `json:"brand"`
	Name      string             `json:"name"`
	Postcode  string             `json:"postcode"`
	Lat       float64            `json:"lat"`
	Lon       float64            `json:"lon"`
	Prices    map[string]float64 `json:"prices"`
	Amenities []string           `json:"amenities,omitempty"`
}

// OutcodePayload represents the minified payload stored in data/outcodes/{OUTCODE}.json.
type OutcodePayload struct {
	Outcode   string    `json:"outcode"`
	UpdatedAt string    `json:"updated_at"`
	Stations  []Station `json:"stations"`
}

// OutcodeIndexItem describes an outcode in the global index file.
type OutcodeIndexItem struct {
	Outcode      string             `json:"outcode"`
	StationCount int                `json:"station_count"`
	Lat          float64            `json:"lat,omitempty"`
	Lon          float64            `json:"lon,omitempty"`
	MinPrices    map[string]float64 `json:"min_prices,omitempty"`
}

// IndexPayload represents the root summary stored in data/outcodes/index.json.
type IndexPayload struct {
	UpdatedAt     string             `json:"updated_at"`
	TotalStations int                `json:"total_stations"`
	TotalOutcodes int                `json:"total_outcodes"`
	Outcodes      []OutcodeIndexItem `json:"outcodes"`
}

var outcodeRegex = regexp.MustCompile(`^[A-Z]{1,2}[0-9][0-9A-Z]?$`)

// ExtractOutcode extracts and normalizes the UK outcode from a postcode string.
// Examples:
// "SW1A 1AA" -> "SW1A"
// "sw1a1aa"  -> "SW1A"
// "SS1 2EF"  -> "SS1"
// "BS1"      -> "BS1"
func ExtractOutcode(postcode string) string {
	cleaned := strings.ToUpper(strings.TrimSpace(postcode))
	if cleaned == "" {
		return "UNKNOWN"
	}

	parts := strings.Fields(cleaned)
	if len(parts) >= 2 {
		candidate := parts[0]
		if outcodeRegex.MatchString(candidate) {
			return candidate
		}
	}

	compact := strings.ReplaceAll(cleaned, " ", "")
	if len(compact) > 3 {
		// UK incode is always the last 3 characters: 1 digit + 2 letters
		candidate := compact[:len(compact)-3]
		if outcodeRegex.MatchString(candidate) {
			return candidate
		}
	}

	if outcodeRegex.MatchString(compact) {
		return compact
	}

	return "UNKNOWN"
}

// GroupStationsByOutcode organizes a slice of stations into an outcode map.
func GroupStationsByOutcode(stations []Station) map[string][]Station {
	grouped := make(map[string][]Station)
	for _, station := range stations {
		outcode := ExtractOutcode(station.Postcode)
		grouped[outcode] = append(grouped[outcode], station)
	}
	return grouped
}

// ShardOptions controls output generation options.
type ShardOptions struct {
	OutputDir   string
	Timestamp   time.Time
	Concurrency int
}

// ShardAndWrite writes minified outcode JSON files and the master index.json.
func ShardAndWrite(stations []Station, opts ShardOptions) (*IndexPayload, error) {
	if opts.OutputDir == "" {
		opts.OutputDir = filepath.Join("data", "outcodes")
	}
	if opts.Timestamp.IsZero() {
		opts.Timestamp = time.Now().UTC()
	}
	if opts.Concurrency <= 0 {
		opts.Concurrency = 16
	}

	if err := os.MkdirAll(opts.OutputDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create output directory %s: %w", opts.OutputDir, err)
	}

	// Clean existing JSON files in OutputDir to prevent stale outcode shards
	if files, err := filepath.Glob(filepath.Join(opts.OutputDir, "*.json")); err == nil {
		for _, f := range files {
			_ = os.Remove(f)
		}
	}

	grouped := GroupStationsByOutcode(stations)
	updatedAtStr := opts.Timestamp.Format(time.RFC3339)

	var (
		indexItems = make([]OutcodeIndexItem, 0, len(grouped))
		indexMutex sync.Mutex
		wg         sync.WaitGroup
		semaphore  = make(chan struct{}, opts.Concurrency)
		errChan    = make(chan error, len(grouped))
	)

	for outcode, stationList := range grouped {
		wg.Add(1)
		semaphore <- struct{}{}

		go func(oc string, list []Station) {
			defer wg.Done()
			defer func() { <-semaphore }()

			// Calculate minimum prices and center coordinates
			minPrices := make(map[string]float64)
			var sumLat, sumLon float64
			var validCoords int

			for _, st := range list {
				if st.Lat != 0 || st.Lon != 0 {
					sumLat += st.Lat
					sumLon += st.Lon
					validCoords++
				}
				for grade, price := range st.Prices {
					if price <= 0 {
						continue
					}
					if current, exists := minPrices[grade]; !exists || price < current {
						minPrices[grade] = price
					}
				}
			}

			var avgLat, avgLon float64
			if validCoords > 0 {
				avgLat = float64(int(sumLat/float64(validCoords)*10000)) / 10000
				avgLon = float64(int(sumLon/float64(validCoords)*10000)) / 10000
			}

			payload := OutcodePayload{
				Outcode:   oc,
				UpdatedAt: updatedAtStr,
				Stations:  list,
			}

			data, err := json.Marshal(payload)
			if err != nil {
				errChan <- fmt.Errorf("failed to marshal outcode %s: %w", oc, err)
				return
			}

			filePath := filepath.Join(opts.OutputDir, fmt.Sprintf("%s.json", oc))
			if err := os.WriteFile(filePath, data, 0644); err != nil {
				errChan <- fmt.Errorf("failed to write %s: %w", filePath, err)
				return
			}

			indexMutex.Lock()
			indexItems = append(indexItems, OutcodeIndexItem{
				Outcode:      oc,
				StationCount: len(list),
				Lat:          avgLat,
				Lon:          avgLon,
				MinPrices:    minPrices,
			})
			indexMutex.Unlock()
		}(outcode, stationList)
	}

	wg.Wait()
	close(errChan)

	if len(errChan) > 0 {
		return nil, <-errChan
	}

	// Sort index items alphabetically by outcode
	sort.Slice(indexItems, func(i, j int) bool {
		return indexItems[i].Outcode < indexItems[j].Outcode
	})

	index := &IndexPayload{
		UpdatedAt:     updatedAtStr,
		TotalStations: len(stations),
		TotalOutcodes: len(indexItems),
		Outcodes:      indexItems,
	}

	indexData, err := json.Marshal(index)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal index payload: %w", err)
	}

	indexPath := filepath.Join(opts.OutputDir, "index.json")
	if err := os.WriteFile(indexPath, indexData, 0644); err != nil {
		return nil, fmt.Errorf("failed to write index file %s: %w", indexPath, err)
	}

	return index, nil
}
