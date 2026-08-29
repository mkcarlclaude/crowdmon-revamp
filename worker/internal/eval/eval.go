// Package eval computes detection mAP for M26's evaluation harness
// (docs/superpowers/plans/2026-08-28-eval-harness.md §B, #177) — the scorer
// that turns ground-truth boxes (migration 0014) and a model's predictions
// into the first number in the mAP series PRD §5 promises.
//
// The whole finding this milestone exists to fix has nothing to do with the
// math in this file. AveragePrecision below is an ordinary VOC-style AP, no
// different from any tutorial's. The fix is what it is handed: every label
// this app produced before M26 was a box some model had already proposed,
// so a metric fed only "predictions and what a human ruled on them" cannot
// see a model that finds something no earlier model ever found — it scores
// that detection as a false positive, and the series trends backwards as
// the model improves. This package does not know or care where its
// `GroundTruth` slice came from; it is on `worker/cmd/eval` and the API's
// `GET /api/admin/eval-source` (apps/api/src/routes/admin-eval.ts) to make
// sure that slice is `ground_truth` (migration 0014), independent of any
// model, and not `predictions` filtered down to what something already
// found.
package eval

import "sort"

// Box is a normalized [0,1] axis-aligned box, migration 0003's and 0014's
// own coordinate convention — unitless, because nothing here needs pixels
// or a specific image's dimensions.
type Box struct {
	XMin, YMin, XMax, YMax float64
}

// IoU is intersection over union. Zero for two boxes with no overlap,
// including the degenerate case of zero-area boxes, rather than dividing by
// zero.
func IoU(a, b Box) float64 {
	interXMin := max(a.XMin, b.XMin)
	interYMin := max(a.YMin, b.YMin)
	interXMax := min(a.XMax, b.XMax)
	interYMax := min(a.YMax, b.YMax)

	interW := interXMax - interXMin
	interH := interYMax - interYMin
	if interW <= 0 || interH <= 0 {
		return 0
	}
	inter := interW * interH

	areaA := (a.XMax - a.XMin) * (a.YMax - a.YMin)
	areaB := (b.XMax - b.XMin) * (b.YMax - b.YMin)
	union := areaA + areaB - inter
	if union <= 0 {
		return 0
	}
	return inter / union
}

// Detection is one prediction, scoped to the image it was made on.
//
// **`ImageID` is load-bearing, not bookkeeping.** IoU is only ever computed
// between a detection and ground truth on the *same* image — matching
// `ground_truth.image_id`'s own scope (migration 0014) — so two boxes with
// identical coordinates on two different images are never a match. A
// scorer that flattened every image's boxes into one shared space would
// let a detection on frame 40 "find" a Paimon the annotator drew on frame
// 12, which is not a detection at all.
type Detection struct {
	ImageID    int
	Box        Box
	Confidence float64
}

// GroundTruth is one labelled instance, scoped to its image the same way.
type GroundTruth struct {
	ImageID int
	Box     Box
}

// PRPoint is one point on the precision-recall curve, at the confidence of
// the detection that produced it.
//
// One point per detection's own confidence, not an externally chosen grid:
// this detector's confidences sit at 0.10-0.20 (plan §B2), and a tutorial's
// 0.1-step sweep from 0 to 1 would land almost entirely outside the range
// any real prediction ever takes. Every operating point a caller could
// actually choose is on this curve already.
type PRPoint struct {
	Confidence float64 `json:"confidence"`
	Precision  float64 `json:"precision"`
	Recall     float64 `json:"recall"`
}

// APResult is one class's score at one IoU threshold.
type APResult struct {
	AP          float64
	GroundTruth int // total ground-truth boxes for this class, matched or not — AP's denominator.
	Curve       []PRPoint
}

// AveragePrecision scores one class's detections against its ground truth
// at one IoU threshold, using the PASCAL VOC 2012 "all points" definition:
// the area under the precision envelope, where precision at each recall
// level is replaced by the highest precision achieved at that recall or
// beyond. Exact, not sampled at a grid — the property that makes a small
// fixture's AP computable on paper and asserted exactly (plan §Verification
// item 2).
//
// **`APResult.GroundTruth` is `len(groundTruth)`, not "how many were
// matched," and that one line is the entire fix M26 exists to make.** A
// ground-truth box no detection ever reaches still counts in AP's
// denominator, which is what drags recall — and therefore AP — down when
// the pool holds an instance nothing was ever proposed on. Building this
// count from the *matched* set instead would reproduce the inverted metric
// the plan opens with, and a fixture that only exercised 100% recall could
// never catch the mistake; see `TestUnmatchedGroundTruthLowersScore` for
// the fixture that does.
func AveragePrecision(detections []Detection, groundTruth []GroundTruth, iouThreshold float64) APResult {
	// One claimed flag per ground-truth box, grouped by image — migration
	// 0014's own scope (`Detection`'s own comment): a detection can only
	// ever be matched against ground truth on the image it was made on.
	type claim struct {
		box     Box
		claimed bool
	}
	byImage := make(map[int][]*claim, len(groundTruth))
	for _, gt := range groundTruth {
		byImage[gt.ImageID] = append(byImage[gt.ImageID], &claim{box: gt.Box})
	}

	ranked := make([]Detection, len(detections))
	copy(ranked, detections)
	// Stable: two detections tied on confidence keep the order the caller
	// gave them in, so a fixture with a tie has one defined answer instead
	// of one that depends on sort's internal pivoting.
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].Confidence > ranked[j].Confidence })

	curve := make([]PRPoint, len(ranked))
	var tp, fp int

	for i, d := range ranked {
		var (
			bestIoU = -1.0
			bestGT  *claim
		)
		for _, gt := range byImage[d.ImageID] {
			if gt.claimed {
				continue
			}
			if iou := IoU(d.Box, gt.box); iou >= iouThreshold && iou > bestIoU {
				bestIoU = iou
				bestGT = gt
			}
		}

		// The unmatched-prediction case (plan §Verification item 3): no
		// unclaimed ground-truth box on this image reaches the threshold,
		// so this detection is a false positive regardless of how many
		// other images' ground truth it happens to resemble.
		if bestGT != nil {
			bestGT.claimed = true
			tp++
		} else {
			fp++
		}

		precision := float64(tp) / float64(tp+fp)
		var recall float64
		if len(groundTruth) > 0 {
			recall = float64(tp) / float64(len(groundTruth))
		}
		curve[i] = PRPoint{Confidence: d.Confidence, Precision: precision, Recall: recall}
	}

	return APResult{AP: areaUnderCurve(curve, len(groundTruth)), GroundTruth: len(groundTruth), Curve: curve}
}

// areaUnderCurve is the PASCAL VOC 2012 all-points AP, computed exactly
// from the ranked curve rather than sampled at a grid.
//
// A class with no ground truth at all (`totalGT == 0`) scores 0 rather than
// dividing by zero: every detection made against it is necessarily a false
// positive, since there is nothing to recall.
func areaUnderCurve(curve []PRPoint, totalGT int) float64 {
	if totalGT == 0 {
		return 0
	}

	// The curve bracketed by its two fixed endpoints — the standard
	// construction, not this package's own invention: recall 0 at
	// precision 0 (nothing has been detected yet), recall 1 at precision 0
	// (nothing beyond the ranked detections could ever raise precision at
	// full recall, so the curve is defined to end there).
	recall := make([]float64, 0, len(curve)+2)
	precision := make([]float64, 0, len(curve)+2)
	recall = append(recall, 0)
	precision = append(precision, 0)
	for _, p := range curve {
		recall = append(recall, p.Recall)
		precision = append(precision, p.Precision)
	}
	recall = append(recall, 1)
	precision = append(precision, 0)

	// The envelope: walking backward, every point's precision becomes the
	// highest precision reached at that recall level or any level past it.
	// This is what lets a false positive ranked *after* full recall was
	// already reached cost nothing — the metric is defined that way, and a
	// caller reading `Curve` still sees the raw (non-enveloped) precision
	// at every rank if that distinction matters to them.
	for i := len(precision) - 2; i >= 0; i-- {
		if precision[i+1] > precision[i] {
			precision[i] = precision[i+1]
		}
	}

	var ap float64
	for i := 0; i < len(recall)-1; i++ {
		ap += (recall[i+1] - recall[i]) * precision[i+1]
	}
	return ap
}

// COCOThresholds are the ten IoU thresholds mAP@[.5:.95] averages over —
// 0.05 apart from 0.50 to 0.95 inclusive, COCO's own definition and the one
// plan §B2 names for "catches a model that finds the right things and boxes
// them sloppily." `COCOThresholds[0]` is relied on to be 0.50 by `Score`
// below, which reuses the AP@0.5 result already computed for the headline
// number rather than scoring that threshold twice.
var COCOThresholds = []float64{0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95}

// ClassSet is one class's detections and ground truth — the unit `Score`
// takes one of per class in the roster, gathered from
// `GET /api/admin/eval-source`'s per-image lists and regrouped by
// `class_name`.
type ClassSet struct {
	Class       string
	Detections  []Detection
	GroundTruth []GroundTruth
}

// ClassReport is one class's numbers in the shape `worker/cmd/eval` prints
// and writes. "Per class, even at one class today" (plan §B2, echoing
// ROADMAP M25's own reasoning for `diverse`): the shape does not change the
// day a second active class returns, so it is not built as a special case
// of one.
type ClassReport struct {
	Class            string    `json:"class"`
	AP50             float64   `json:"ap_50"`
	AP5095           float64   `json:"ap_50_95"`
	GroundTruthCount int       `json:"ground_truth_count"`
	PredictionCount  int       `json:"prediction_count"`
	ConfidenceSweep  []PRPoint `json:"confidence_sweep"`
}

// Report is the whole evaluation run — plan §B3: no `model_versions` row
// (M27's, once one exists to register), a file beside the snapshot in R2
// and the same summary printed.
type Report struct {
	MAP50   float64       `json:"map_50"`
	MAP5095 float64       `json:"map_50_95"`
	Classes []ClassReport `json:"classes"`
}

// Score computes the whole report: every class's AP@0.5 and AP@[.5:.95],
// and the two means across classes. A class with zero ground truth still
// gets a row rather than being omitted — the same "per class" reasoning
// `ClassReport` documents — scoring 0 rather than silently disappearing
// from the report the day its ground truth pool is empty.
func Score(sets []ClassSet) Report {
	classes := make([]ClassReport, len(sets))
	var map50, map5095 float64

	for i, set := range sets {
		at50 := AveragePrecision(set.Detections, set.GroundTruth, 0.5)

		// `COCOThresholds[0]` is 0.50 by construction, so `at50.AP` above
		// already is that term of the sum — scored once, not twice.
		sum5095 := at50.AP
		for _, threshold := range COCOThresholds[1:] {
			sum5095 += AveragePrecision(set.Detections, set.GroundTruth, threshold).AP
		}
		ap5095 := sum5095 / float64(len(COCOThresholds))

		classes[i] = ClassReport{
			Class:            set.Class,
			AP50:             at50.AP,
			AP5095:           ap5095,
			GroundTruthCount: len(set.GroundTruth),
			PredictionCount:  len(set.Detections),
			ConfidenceSweep:  at50.Curve,
		}
		map50 += at50.AP
		map5095 += ap5095
	}

	if len(sets) > 0 {
		map50 /= float64(len(sets))
		map5095 /= float64(len(sets))
	}

	return Report{MAP50: map50, MAP5095: map5095, Classes: classes}
}
