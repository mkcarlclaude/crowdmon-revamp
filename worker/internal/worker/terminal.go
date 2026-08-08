package worker

import "errors"

// ErrObjectMissing says an image row points at an R2 object that is not
// there. A Detector returns it (wrapped, however it likes) and the prelabel
// branch turns it into a Terminal failure.
//
// A sentinel rather than the prelabel branch inspecting an S3 404 itself: the
// branch must not know what storage the Detector talks to, which is the whole
// point of the interface being one method. This is the vocabulary the two
// share for the one failure whose classification the caller cannot guess.
var ErrObjectMissing = errors.New("the image object is missing from storage")

// Terminal marks a failure that retrying cannot fix: a deleted video, a
// private one, a source file that is not on this box.
//
// This is the sorting CONTEXT.md §Q14 deferred from M6 to M7.1, and it is
// drawn here rather than at the API because only the code that ran the work
// knows what went wrong. What the API sees is the consequence: a job reported
// as failed is retired on the first report, so a failure worth retrying must
// not be reported at all.
//
// The default is retryable. A failure nobody has classified is left `claimed`
// and handed back by the reaper, which costs a lease window and an attempt; a
// failure wrongly marked terminal burns a video permanently on its first bad
// day. The cheap mistake is the one to make by default.
func Terminal(err error) error {
	if err == nil {
		return nil
	}
	return terminalError{err}
}

// IsTerminal reports whether err was marked by Terminal, anywhere under the
// wrapping its callers added on the way up.
func IsTerminal(err error) bool {
	var marked terminalError
	return errors.As(err, &marked)
}

// terminalError carries the marker. A type rather than a sentinel wrapped with
// %w, so `errors.As` finds it however deeply the error is nested and the
// original error keeps its own identity for anything matching on it.
type terminalError struct{ err error }

func (e terminalError) Error() string { return e.err.Error() }
func (e terminalError) Unwrap() error { return e.err }
