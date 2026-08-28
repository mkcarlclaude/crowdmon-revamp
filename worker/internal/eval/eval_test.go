package eval

import (
	"math"
	"testing"
)

// approxEqual matches float64 sums built from divisions like 1/3 — exact
// equality would be testing IEEE 754's rounding behaviour, not this
// package's arithmetic.
func approxEqual(t *testing.T, got, want float64) {
	t.Helper()
	const epsilon = 1e-9
	if math.Abs(got-want) > epsilon {
		t.Errorf("got %.10f, want %.10f", got, want)
	}
}

func TestIoU(t *testing.T) {
	t.Run("identical boxes", func(t *testing.T) {
		box := Box{XMin: 0.1, YMin: 0.1, XMax: 0.5, YMax: 0.5}
		approxEqual(t, IoU(box, box), 1.0)
	})

	t.Run("disjoint boxes", func(t *testing.T) {
		a := Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}
		b := Box{XMin: 0.5, YMin: 0.5, XMax: 0.7, YMax: 0.7}
		approxEqual(t, IoU(a, b), 0)
	})

	t.Run("touching but not overlapping is zero, not a division artifact", func(t *testing.T) {
		a := Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}
		b := Box{XMin: 0.2, YMin: 0, XMax: 0.4, YMax: 0.2}
		approxEqual(t, IoU(a, b), 0)
	})

	t.Run("a known 50% overlap, worked out by hand", func(t *testing.T) {
		// Two 0.2x0.3 boxes, one shifted down by 0.1: intersection is
		// 0.2x0.2 = 0.04, each box's own area is 0.06, union is
		// 0.06+0.06-0.04 = 0.08, IoU = 0.04/0.08 = 0.5 exactly.
		a := Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.3}
		b := Box{XMin: 0, YMin: 0.1, XMax: 0.2, YMax: 0.4}
		approxEqual(t, IoU(a, b), 0.5)
	})
}

// TestAveragePrecisionHandComputedFixture is plan §Verification item 2: a
// fixture whose AP can be worked out on paper, asserted exactly. Three
// ground-truth boxes, one image, four detections ranked by confidence:
//
//	D1 (conf 0.9) exactly matches GT1                -> TP
//	D2 (conf 0.8) exactly matches GT2                -> TP
//	D3 (conf 0.7) duplicates D1's box; GT1 is claimed -> FP
//	D4 (conf 0.6) matches nothing                    -> FP
//	GT3 is never matched by anything                 -> the recall gap
//
// Ranked precision: 1.0, 1.0, 0.6667, 0.5
// Ranked recall (totalGT=3): 0.3333, 0.6667, 0.6667, 0.6667
//
// The precision envelope stays 1.0 through both points where recall still
// increases (cumulative TP is monotonically 1, then 2, and precision was
// 1.0 at both of those ranks — the two later false positives can only pull
// precision down at ranks *after* recall has already stopped climbing, and
// the envelope only ever looks forward for a higher value). So
// AP = (0.3333 - 0) * 1.0 + (0.6667 - 0.3333) * 1.0 = 2/3 — every later
// term multiplies a zero-width recall interval and contributes nothing.
func TestAveragePrecisionHandComputedFixture(t *testing.T) {
	gt := []GroundTruth{
		{ImageID: 1, Box: Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}},     // GT1
		{ImageID: 1, Box: Box{XMin: 0.3, YMin: 0.3, XMax: 0.5, YMax: 0.5}}, // GT2
		{ImageID: 1, Box: Box{XMin: 0.6, YMin: 0.6, XMax: 0.8, YMax: 0.8}}, // GT3 — never matched
	}
	detections := []Detection{
		{ImageID: 1, Confidence: 0.9, Box: Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}},     // D1, matches GT1
		{ImageID: 1, Confidence: 0.8, Box: Box{XMin: 0.3, YMin: 0.3, XMax: 0.5, YMax: 0.5}}, // D2, matches GT2
		{ImageID: 1, Confidence: 0.7, Box: Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}},     // D3, GT1 already claimed
		{ImageID: 1, Confidence: 0.6, Box: Box{XMin: 0.9, YMin: 0.9, XMax: 1.0, YMax: 1.0}}, // D4, matches nothing
	}

	result := AveragePrecision(detections, gt, 0.5)

	approxEqual(t, result.AP, 2.0/3.0)
	if result.GroundTruth != 3 {
		t.Errorf("GroundTruth = %d, want 3", result.GroundTruth)
	}
	if len(result.Curve) != 4 {
		t.Fatalf("Curve has %d points, want 4", len(result.Curve))
	}
	// The curve itself, at the confidence of each ranked detection — the
	// raw per-rank precision/recall, not the enveloped values AP integrates
	// over (this package's own comment on why both are kept).
	wantCurve := []PRPoint{
		{Confidence: 0.9, Precision: 1.0, Recall: 1.0 / 3.0},
		{Confidence: 0.8, Precision: 1.0, Recall: 2.0 / 3.0},
		{Confidence: 0.7, Precision: 2.0 / 3.0, Recall: 2.0 / 3.0},
		{Confidence: 0.6, Precision: 0.5, Recall: 2.0 / 3.0},
	}
	for i, want := range wantCurve {
		got := result.Curve[i]
		if got.Confidence != want.Confidence {
			t.Errorf("Curve[%d].Confidence = %v, want %v", i, got.Confidence, want.Confidence)
		}
		approxEqual(t, got.Precision, want.Precision)
		approxEqual(t, got.Recall, want.Recall)
	}
}

// TestUnmatchedGroundTruthLowersScore is plan §Verification item 3: the
// entire failure M26 exists to fix. A ground-truth box with no matching
// prediction anywhere must lower AP, and it must be impossible to pass this
// test by scoring only where predictions already exist — a scorer built
// that way would compute `GroundTruth` from the matched set and see no
// difference between the two cases below at all.
func TestUnmatchedGroundTruthLowersScore(t *testing.T) {
	matchedGT := GroundTruth{ImageID: 1, Box: Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}}
	detection := Detection{ImageID: 1, Confidence: 0.9, Box: matchedGT.Box}

	baseline := AveragePrecision([]Detection{detection}, []GroundTruth{matchedGT}, 0.5)
	approxEqual(t, baseline.AP, 1.0)

	// A second ground-truth box on the same image, far from the first, that
	// no detection ever proposes — a Paimon the detector missed entirely,
	// the exact case the plan's own finding is about ("nothing was
	// proposed there, so nothing was shown to an admin").
	unmatchedGT := GroundTruth{ImageID: 1, Box: Box{XMin: 0.6, YMin: 0.6, XMax: 0.8, YMax: 0.8}}
	withMiss := AveragePrecision(
		[]Detection{detection},
		[]GroundTruth{matchedGT, unmatchedGT},
		0.5,
	)

	if withMiss.AP >= baseline.AP {
		t.Fatalf("AP with a missed ground-truth box (%.4f) did not drop below the baseline (%.4f)",
			withMiss.AP, baseline.AP)
	}
	// Recall caps at 1/2 with perfect precision throughout, so AP is
	// exactly the recall it reached: (0.5 - 0) * 1.0 = 0.5.
	approxEqual(t, withMiss.AP, 0.5)
	if withMiss.GroundTruth != 2 {
		t.Errorf("GroundTruth = %d, want 2 — the missed box must still count in the denominator",
			withMiss.GroundTruth)
	}
}

// TestUnmatchedPredictionIsAFalsePositive is plan §Verification item 4, the
// mirror image of the test above: a detection with no matching ground truth
// anywhere is a false positive and must lower AP, not be quietly ignored
// because "nothing was there to compare it to."
//
// Ranked ahead of the second true positive, not after it — a false
// positive ranked *after* full recall is already reached costs this metric
// nothing (`areaUnderCurve`'s own comment on the envelope), so placing it
// there would prove nothing about whether unmatched predictions are
// penalised at all.
func TestUnmatchedPredictionIsAFalsePositive(t *testing.T) {
	gt1 := GroundTruth{ImageID: 1, Box: Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}}
	gt2 := GroundTruth{ImageID: 1, Box: Box{XMin: 0.6, YMin: 0.6, XMax: 0.8, YMax: 0.8}}
	d1 := Detection{ImageID: 1, Confidence: 0.9, Box: gt1.Box}
	d3 := Detection{ImageID: 1, Confidence: 0.7, Box: gt2.Box}

	baseline := AveragePrecision([]Detection{d1, d3}, []GroundTruth{gt1, gt2}, 0.5)
	approxEqual(t, baseline.AP, 1.0)

	// An extra detection at confidence 0.8 — between d1 and d3 — matching
	// nothing on the image.
	falsePositive := Detection{ImageID: 1, Confidence: 0.8, Box: Box{XMin: 0.3, YMin: 0.3, XMax: 0.5, YMax: 0.5}}
	withExtra := AveragePrecision([]Detection{d1, falsePositive, d3}, []GroundTruth{gt1, gt2}, 0.5)

	if withExtra.AP >= baseline.AP {
		t.Fatalf("AP with an unmatched prediction (%.4f) did not drop below the baseline (%.4f)",
			withExtra.AP, baseline.AP)
	}
	// Worked out by hand: precision after each rank is 1.0, 0.5, 0.6667;
	// recall is 0.5, 0.5, 1.0. The envelope leaves 1.0 over [0, 0.5] and
	// 0.6667 over [0.5, 1.0]: AP = 0.5*1.0 + 0.5*0.6667 = 5/6.
	approxEqual(t, withExtra.AP, 5.0/6.0)
}

// TestDetectionsDoNotMatchGroundTruthOnAnotherImage: `Detection.ImageID`'s
// own load-bearing comment, exercised. Identical coordinates on two
// different images must not be treated as the same box.
func TestDetectionsDoNotMatchGroundTruthOnAnotherImage(t *testing.T) {
	box := Box{XMin: 0.1, YMin: 0.1, XMax: 0.3, YMax: 0.3}
	gt := []GroundTruth{{ImageID: 2, Box: box}}
	detections := []Detection{{ImageID: 1, Confidence: 0.9, Box: box}}

	result := AveragePrecision(detections, gt, 0.5)

	// The detection is a false positive (wrong image), and the ground
	// truth is unmatched: recall never leaves zero, so AP is 0.
	approxEqual(t, result.AP, 0)
	if len(result.Curve) != 1 || result.Curve[0].Precision != 0 {
		t.Fatalf("expected the lone detection to be scored as a false positive, got %+v", result.Curve)
	}
}

func TestIoUThresholdControlsWhatCountsAsAMatch(t *testing.T) {
	// The same 50%-overlap pair `TestIoU` verifies by hand. The threshold is
	// the pair's own computed IoU, not the literal `0.5` — float64 division
	// rounds `0.04/0.08` to 0.49999999999999994, not the mathematical 0.5,
	// so a threshold of the literal `0.5` would narrowly and misleadingly
	// fail an inclusive `>=` here. Comparing the value to itself is what
	// actually tests "the threshold is inclusive," regardless of which way
	// IEEE 754 happened to round this particular pair.
	gtBox := Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.3}
	predBox := Box{XMin: 0, YMin: 0.1, XMax: 0.2, YMax: 0.4}
	iou := IoU(gtBox, predBox)

	gt := GroundTruth{ImageID: 1, Box: gtBox}
	detection := Detection{ImageID: 1, Confidence: 0.9, Box: predBox}

	atExactly := AveragePrecision([]Detection{detection}, []GroundTruth{gt}, iou)
	approxEqual(t, atExactly.AP, 1.0)

	// A safe margin above the pair's own IoU, not a hardcoded threshold
	// that could itself land on the wrong side of a rounding error.
	above := AveragePrecision([]Detection{detection}, []GroundTruth{gt}, iou+0.01)
	approxEqual(t, above.AP, 0)
}

func TestAveragePrecisionWithNoGroundTruthIsZeroNotANaN(t *testing.T) {
	detections := []Detection{{ImageID: 1, Confidence: 0.9, Box: Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}}}

	result := AveragePrecision(detections, nil, 0.5)

	approxEqual(t, result.AP, 0)
	if result.GroundTruth != 0 {
		t.Errorf("GroundTruth = %d, want 0", result.GroundTruth)
	}
}

// TestAP5095CatchesLocalizationDriftThatAP50Misses is plan §B2's own
// argument for reporting both numbers: a model that finds the right things
// and boxes them sloppily. One detection with a comfortable IoU margin
// above 0.5 but below every COCO threshold from 0.60 on: AP50 is perfect,
// AP@[.5:.95] is not, because two of the ten thresholds (0.50 and 0.55) are
// cleared and eight are not.
func TestAP5095CatchesLocalizationDriftThatAP50Misses(t *testing.T) {
	// Same shift construction as `TestIoU`'s hand-worked case
	// (IoU = (h-dy)/(h+dy)) with h=0.3, dy=0.08: IoU = 0.22/0.38 = 11/19 ≈
	// 0.579, comfortably inside (0.55, 0.60) with margin either side of both
	// nearby COCO thresholds — a value picked to avoid the exact-boundary
	// rounding trap `TestIoUThresholdControlsWhatCountsAsAMatch` documents.
	gt := GroundTruth{ImageID: 1, Box: Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.3}}
	detection := Detection{ImageID: 1, Confidence: 0.9, Box: Box{XMin: 0, YMin: 0.08, XMax: 0.2, YMax: 0.38}}

	iou := IoU(gt.Box, detection.Box)
	if iou <= 0.55 || iou >= 0.60 {
		t.Fatalf("fixture assumption violated: IoU = %v is not strictly between 0.55 and 0.60", iou)
	}

	report := Score([]ClassSet{
		{Class: "Paimon", Detections: []Detection{detection}, GroundTruth: []GroundTruth{gt}},
	})

	approxEqual(t, report.MAP50, 1.0)
	// TP at 0.50 and 0.55, FP at the eight thresholds from 0.60 to 0.95:
	// (1.0 + 1.0 + 0*8) / 10.
	approxEqual(t, report.MAP5095, 0.2)
	if report.MAP5095 >= report.MAP50 {
		t.Fatalf("AP@[.5:.95] (%.4f) did not drop below AP@0.5 (%.4f) for a sloppily-boxed detection",
			report.MAP5095, report.MAP50)
	}
}

func TestScoreAveragesAcrossClasses(t *testing.T) {
	perfect := GroundTruth{ImageID: 1, Box: Box{XMin: 0, YMin: 0, XMax: 0.2, YMax: 0.2}}
	perfectDetection := Detection{ImageID: 1, Confidence: 0.9, Box: perfect.Box}
	// A Paimon nothing was ever proposed on — a total miss, AP 0 at every
	// threshold.
	missed := GroundTruth{ImageID: 2, Box: Box{XMin: 0.4, YMin: 0.4, XMax: 0.6, YMax: 0.6}}

	report := Score([]ClassSet{
		{Class: "Paimon", Detections: []Detection{perfectDetection}, GroundTruth: []GroundTruth{perfect}},
		{Class: "Hu Tao", Detections: nil, GroundTruth: []GroundTruth{missed}},
	})

	// (1.0 + 0) / 2, both at AP50 and at AP@[.5:.95] — a perfect match
	// clears every one of the ten COCO thresholds identically.
	approxEqual(t, report.MAP50, 0.5)
	approxEqual(t, report.MAP5095, 0.5)
	if len(report.Classes) != 2 {
		t.Fatalf("expected one row per class, got %+v", report.Classes)
	}
	if report.Classes[0].Class != "Paimon" || report.Classes[1].Class != "Hu Tao" {
		t.Fatalf("expected class rows in the order given, got %+v", report.Classes)
	}
	if len(report.Classes[0].ConfidenceSweep) != 1 {
		t.Fatalf("expected the confidence sweep to carry the one detection's point")
	}
}

func TestScoreGivesAClassWithNoGroundTruthItsOwnZeroRow(t *testing.T) {
	report := Score([]ClassSet{
		{Class: "Hu Tao", Detections: nil, GroundTruth: nil},
	})

	approxEqual(t, report.MAP50, 0)
	if len(report.Classes) != 1 {
		t.Fatalf("a class with no ground truth must still get a row, got %+v", report.Classes)
	}
}
