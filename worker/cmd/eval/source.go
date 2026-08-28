package main

import "github.com/mkcarlclaude/crowdmon-revamp/worker/internal/eval"

// evalSource mirrors `GET /api/admin/eval-source`'s response
// (`EvalSource` in apps/api/src/schemas.ts) — see main.go's own doc comment
// for why this is a hand-written type rather than the generated client.
type evalSource struct {
	Images []evalSourceImage `json:"images"`
}

type evalSourceImage struct {
	ImageID     int                    `json:"image_id"`
	Predictions []evalSourcePrediction `json:"predictions"`
	GroundTruth []evalSourceBox        `json:"ground_truth"`
}

// evalSourceBox is one box, before it is known whether it is a prediction
// or a ground-truth instance — `class_name` travels on both, `EvalSource`'s
// own reason (schemas.ts): the scorer groups by class on its own and a
// separate roster buys this command nothing.
type evalSourceBox struct {
	ClassName string  `json:"class_name"`
	XMin      float64 `json:"x_min"`
	YMin      float64 `json:"y_min"`
	XMax      float64 `json:"x_max"`
	YMax      float64 `json:"y_max"`
}

// evalSourcePrediction is a box plus the one field a ground-truth box does
// not carry. Embedded rather than duplicated: `evalSourceBox`'s fields are
// unexported-package-local and anonymous embedding is what makes
// encoding/json flatten them into the same JSON object `EvalSourcePrediction`
// (schemas.ts) is, rather than nesting a `box` object the wire shape does
// not have.
type evalSourcePrediction struct {
	evalSourceBox
	Confidence float64 `json:"confidence"`
}

// classSets regroups `evalSource`'s per-image lists by class name — the
// shape `eval.Score` actually takes one of per class in the roster. Class
// order is first-seen across `Images`, not sorted, so a report's class
// ordering is stable for one source file without this command inventing an
// opinion about roster order that `GET /api/admin/eval-source` itself does
// not have (that route emits classes in `ORDER BY name`, so in practice
// this already comes out alphabetical too).
func classSets(source evalSource) []eval.ClassSet {
	type accumulator struct {
		detections  []eval.Detection
		groundTruth []eval.GroundTruth
	}

	byClass := make(map[string]*accumulator)
	var order []string

	get := func(class string) *accumulator {
		a, ok := byClass[class]
		if !ok {
			a = &accumulator{}
			byClass[class] = a
			order = append(order, class)
		}
		return a
	}

	for _, image := range source.Images {
		for _, prediction := range image.Predictions {
			a := get(prediction.ClassName)
			a.detections = append(a.detections, eval.Detection{
				ImageID:    image.ImageID,
				Box:        boxOf(prediction.evalSourceBox),
				Confidence: prediction.Confidence,
			})
		}
		for _, box := range image.GroundTruth {
			a := get(box.ClassName)
			a.groundTruth = append(a.groundTruth, eval.GroundTruth{
				ImageID: image.ImageID,
				Box:     boxOf(box),
			})
		}
	}

	sets := make([]eval.ClassSet, len(order))
	for i, class := range order {
		a := byClass[class]
		sets[i] = eval.ClassSet{Class: class, Detections: a.detections, GroundTruth: a.groundTruth}
	}
	return sets
}

func boxOf(b evalSourceBox) eval.Box {
	return eval.Box{XMin: b.XMin, YMin: b.YMin, XMax: b.XMax, YMax: b.YMax}
}
