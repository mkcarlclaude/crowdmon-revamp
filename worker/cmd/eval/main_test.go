package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestClassSetsGroupsByClassNameAcrossImages(t *testing.T) {
	source := evalSource{
		Images: []evalSourceImage{
			{
				ImageID: 1,
				Predictions: []evalSourcePrediction{
					{evalSourceBox{ClassName: "Paimon", XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}, 0.9},
				},
				GroundTruth: []evalSourceBox{
					{ClassName: "Paimon", XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2},
				},
			},
			{
				ImageID: 2,
				Predictions: []evalSourcePrediction{
					{evalSourceBox{ClassName: "Hu Tao", XMin: 0.1, YMin: 0.1, XMax: 0.3, YMax: 0.3}, 0.5},
				},
				GroundTruth: nil, // exhaustively marked, genuinely nothing here — a legal input.
			},
		},
	}

	sets := classSets(source)

	if len(sets) != 2 {
		t.Fatalf("expected 2 classes, got %d: %+v", len(sets), sets)
	}
	if sets[0].Class != "Paimon" || sets[1].Class != "Hu Tao" {
		t.Fatalf("expected first-seen order [Paimon, Hu Tao], got [%s, %s]", sets[0].Class, sets[1].Class)
	}
	if len(sets[0].Detections) != 1 || sets[0].Detections[0].ImageID != 1 {
		t.Errorf("Paimon detections = %+v, want one detection on image 1", sets[0].Detections)
	}
	if len(sets[1].GroundTruth) != 0 {
		t.Errorf("Hu Tao ground truth = %+v, want none", sets[1].GroundTruth)
	}
}

func TestRunReadsScoresAndPrintsAReport(t *testing.T) {
	source := evalSource{
		Images: []evalSourceImage{
			{
				ImageID: 1,
				Predictions: []evalSourcePrediction{
					{evalSourceBox{ClassName: "Paimon", XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}, 0.9},
				},
				GroundTruth: []evalSourceBox{
					{ClassName: "Paimon", XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2},
				},
			},
		},
	}

	encoded, err := json.Marshal(source)
	if err != nil {
		t.Fatalf("marshalling the fixture source: %v", err)
	}

	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "source.json")
	if err := os.WriteFile(sourcePath, encoded, 0o644); err != nil {
		t.Fatalf("writing the fixture source: %v", err)
	}
	outPath := filepath.Join(dir, "report.json")

	var stdout bytes.Buffer
	if err := run([]string{"-source", sourcePath, "-out", outPath}, &stdout); err != nil {
		t.Fatalf("run() returned an error: %v", err)
	}

	var printed report
	if err := json.Unmarshal(stdout.Bytes(), &printed); err != nil {
		t.Fatalf("stdout was not a valid report: %v\noutput: %s", err, stdout.String())
	}
	if printed.MAP50 != 1.0 {
		t.Errorf("printed MAP50 = %v, want 1.0 (a single perfect match)", printed.MAP50)
	}
	if !reflect.DeepEqual(printed.ScoredImageIDs, []int{1}) {
		t.Errorf("printed ScoredImageIDs = %v, want [1]", printed.ScoredImageIDs)
	}
	if printed.ScoredImageCount != 1 {
		t.Errorf("printed ScoredImageCount = %d, want 1", printed.ScoredImageCount)
	}

	writtenBytes, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("-out did not write a file: %v", err)
	}
	var written report
	if err := json.Unmarshal(writtenBytes, &written); err != nil {
		t.Fatalf("the written file was not a valid report: %v", err)
	}
	if written.MAP50 != printed.MAP50 {
		t.Errorf("the written report (%v) disagrees with what was printed (%v)", written.MAP50, printed.MAP50)
	}
	if !reflect.DeepEqual(written.ScoredImageIDs, printed.ScoredImageIDs) {
		t.Errorf("the written report's scored ids (%v) disagree with what was printed (%v)",
			written.ScoredImageIDs, printed.ScoredImageIDs)
	}
}

// TestRunWritesTheScoredImageIDsIntoTheReport is plan §Verification's
// successor requirement (the coordinator's follow-up on #177): the scored
// set has to reach the report explicitly, sorted, regardless of the order
// the source file happened to list images in — comparing two runs by eye
// should not depend on remembering that the source's own order was never a
// promise.
func TestRunWritesTheScoredImageIDsIntoTheReport(t *testing.T) {
	source := evalSource{
		Images: []evalSourceImage{
			{ImageID: 42, Predictions: nil, GroundTruth: nil},
			{ImageID: 7, Predictions: nil, GroundTruth: nil},
			{ImageID: 19, Predictions: nil, GroundTruth: nil},
		},
	}

	encoded, err := json.Marshal(source)
	if err != nil {
		t.Fatalf("marshalling the fixture source: %v", err)
	}

	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "source.json")
	if err := os.WriteFile(sourcePath, encoded, 0o644); err != nil {
		t.Fatalf("writing the fixture source: %v", err)
	}

	var stdout bytes.Buffer
	if err := run([]string{"-source", sourcePath}, &stdout); err != nil {
		t.Fatalf("run() returned an error: %v", err)
	}

	var printed report
	if err := json.Unmarshal(stdout.Bytes(), &printed); err != nil {
		t.Fatalf("stdout was not a valid report: %v\noutput: %s", err, stdout.String())
	}
	if !reflect.DeepEqual(printed.ScoredImageIDs, []int{7, 19, 42}) {
		t.Errorf("ScoredImageIDs = %v, want [7, 19, 42] — sorted, not source order", printed.ScoredImageIDs)
	}
	if printed.ScoredImageCount != 3 {
		t.Errorf("ScoredImageCount = %d, want 3", printed.ScoredImageCount)
	}
}

func TestRunRequiresSource(t *testing.T) {
	var stdout bytes.Buffer
	err := run(nil, &stdout)
	if err == nil {
		t.Fatal("expected an error when -source is not given")
	}
}
