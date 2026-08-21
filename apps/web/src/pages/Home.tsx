import { useEffect } from "react";
import { Link } from "react-router";
import detailFrame from "../assets/landing/detail-frame.jpg";
import heroFrame from "../assets/landing/hero-frame.jpg";
import "./Home.css";

const GITHUB = "https://github.com/mkcarlclaude/crowdmon-revamp";

/**
 * `/` — the settled landing page (M20, plan §A), ported from
 * `design/landing-prototypes:prototypes/landing/landing-hero.html` (commit
 * e3bf8cc, `landing-hero.html`, approved 2026-08-10). Read that commit's
 * `README.md` before changing anything here: this direction survived four
 * rejected alternatives — a conventional dark SaaS page, three concept
 * variants and a light editorial layout — all rejected for the same reason,
 * "looks very AI made." The tells that did it, stacked: near-black
 * background, one saturated accent, a radial glow behind the hero, a
 * white-to-grey gradient-clipped headline, a badge pill above the headline,
 * a bento grid, a Google geometric sans, and evenly spaced cards with hover
 * lift. Any one of those is survivable; reintroducing any of them here
 * undoes the milestone.
 *
 * **The hero is a world, not a section.** A full-bleed real frame at
 * `100svh` (not `100vh` — mobile browser chrome is exactly what `svh`
 * exists to handle), a floating pill nav over it, pipeline state as chips
 * *inside* the scene, then a hard seam into the calm warm document body
 * below. Reference: <https://cofounder.co> — a main *object* in the hero
 * rather than an app-UI screenshot, and the hero reading as "almost a
 * separated thing from the whole page."
 *
 * **The frame is real, and so is the box.** `hero-frame.jpg` is
 * `f-3683.jpg` from that same commit — real output from `GET
 * /api/public/frame`, committed as a static asset rather than fetched live.
 * Three reasons (plan §A4): the hero has to render before any fetch
 * resolves or the seam flashes; a signed R2 URL expires and this page is
 * cached; and CONTEXT.md §Q11's rejected "public gallery of labelled crops"
 * stays rejected by there being exactly one curated frame here rather than
 * an endpoint the page pulls from. The 16% confidence on Paimon's box is
 * the detector's actual output on this frame — never replace it with a
 * cleaner, more confident-looking number. A reader seeing the machine be
 * wrong before reading a word of copy *is* the argument for the human step
 * this page is selling, and the prototype's own README calls a faked
 * confident detection the obvious way for this page to quietly rot.
 *
 * **Nav gains a "Sign in" control (plan §A3).** `/api/auth/google/start` is
 * live — this is a plain link, not a stub, matching `Contribute.tsx`'s own
 * reasoning for why that link can't be a `fetch`: a redirect chain to
 * Google has to leave this origin, which only a real navigation can do. The
 * primary CTA now points at `/contribute` rather than the anonymous demo;
 * `/verify` stays reachable and stays labelled as a demo everywhere it
 * appears, so a visitor never discovers only after signing up that what
 * they already clicked through didn't count.
 */
export function Home() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const prevBodyBackground = body.style.backgroundColor;
    const prevScrollBehavior = root.style.scrollBehavior;

    // The warm "document body" paper color below the hero is genuinely
    // page-level — `styles.css` paints `<body>` with the app's dark
    // `--color-surface` for the admin surface, and that has to lose here or
    // elastic overscroll flashes it behind the hard seam this design is
    // built around. `Home.css` scopes everything else to `.landing`, but
    // `body` itself can't be reached by a class selector on a child.
    body.style.backgroundColor = "#f4f2ec";

    // Smooth scrolling for the nav's #how/#why/#faq anchors, off under
    // prefers-reduced-motion — the prototype's own rule, applied here
    // because `html` is the other selector `Home.css` can't scope to this
    // page alone.
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.style.scrollBehavior = reduceMotion ? "auto" : "smooth";

    return () => {
      body.style.backgroundColor = prevBodyBackground;
      root.style.scrollBehavior = prevScrollBehavior;
    };
  }, []);

  return (
    <div className="landing">
      <header className="hero">
        <div className="scene">
          <div className="frame">
            <img
              src={heroFrame}
              alt="Paimon from Genshin Impact, floating in front of a rocky Liyue landscape, with a magenta detection box drawn around her."
            />
            <svg viewBox="0 0 1000 562" preserveAspectRatio="none" aria-hidden="true">
              {/* Her box starts at 1.2% of the frame height, so its top edge is
                  always at the image edge. The label sits inside the box
                  instead of on its corner — otherwise the nav covers it at
                  every scale. */}
              <rect x={481} y={6.7} width={462} height={555} />
            </svg>
            <span className="tag" style={{ left: "48.1%", top: "13%" }}>
              Paimon <span className="c">0.16</span>
            </span>
          </div>
          <div className="scrim" />
          <div className="scrim-b" />
        </div>

        <span className="float f1">
          <i />
          frame <b>00226</b> extracted
        </span>
        <span className="float f2 pend">
          <i />
          awaiting a human verdict
        </span>
        <span className="float f3">
          <i />
          sampled <b>1 of 200</b> from this video
        </span>

        <nav className="nav">
          <Link className="mark" to="/">
            <span className="g" />
            crowdmon
          </Link>
          <div className="navpill">
            <a href="#how">How it works</a>
            <a href="#why">Why</a>
            <a href="#faq">FAQ</a>
            <a href={GITHUB}>Source</a>
          </div>
          <div className="navact">
            <a className="btn btn-ghost" href="/api/auth/google/start">
              Sign in
            </a>
            <Link className="btn btn-w" to="/contribute">
              Start contributing
            </Link>
          </div>
        </nav>

        <div className="hero-body">
          <div className="hero-in">
            <div className="hero-copy">
              <p className="kick">
                <s />
                Real frame · real model output
              </p>
              <h1>
                That's Paimon.
                <br />
                <span>The model is 16% sure.</span>
              </h1>
              <p className="hero-sub">
                You knew instantly. A computer does not — and teaching one costs thousands of
                examples that a person has labelled by hand.{" "}
                <b>crowdmon makes those examples cheap</b>: it turns recorded gameplay into frames,
                has a model guess at every one, and cuts the human job down to yes, no, or nudge.
              </p>
              <div className="hero-cta">
                <Link className="btn btn-w btn-lg" to="/contribute">
                  Start contributing <span className="ar">→</span>
                </Link>
                <Link className="btn btn-ghost btn-lg" to="/verify">
                  Try the anonymous demo
                </Link>
              </div>
            </div>
          </div>
        </div>

        <div className="hero-foot">
          <span>demo needs no sign-up</span>
          <span>·</span>
          <span>
            runs on <b>one desktop, no GPU</b>
          </span>
          <span>·</span>
          <span>demo verdicts never enter the dataset</span>
        </div>
      </header>

      <div className="strip">
        <div className="wrap strip-in">
          <span className="strip-l">Built with</span>
          <span className="strip-i">Cloudflare Workers</span>
          <span className="strip-i">D1</span>
          <span className="strip-i">R2</span>
          <span className="strip-i">Go</span>
          <span className="strip-i">ONNX</span>
          <span className="strip-i">Prometheus</span>
        </div>
      </div>

      <section className="sec" id="how">
        <div className="wrap">
          <div className="sec-h">
            <p className="eyebrow">How it works</p>
            <h2>
              Three steps, <span>and only one needs a person</span>
            </h2>
            <p>From a link you paste to a dataset somebody could train on.</p>
          </div>
          <div className="steps">
            <div className="step">
              <span className="n">01 — MACHINE</span>
              <h3>Cut the video up</h3>
              <p>
                A worker pulls the video, slices ~2,700 stills, throws away the near-duplicates and
                keeps a random 200 spread across the timeline.
              </p>
            </div>
            <div className="step">
              <span className="n">02 — MACHINE</span>
              <h3>Take a rough guess</h3>
              <p>
                An open-vocabulary detector proposes a box for anything it takes for a character. It
                has never been shown these characters — it works from their names.
              </p>
            </div>
            <div className="step">
              <span className="n">03 — YOU</span>
              <h3>Rule on it</h3>
              <p>
                Accept, adjust, or reject. Seconds per frame instead of minutes. Verdicts are
                append-only and packaged into a snapshot with a train/test split.
              </p>
            </div>
          </div>

          <figure className="plate">
            <div>
              <div style={{ position: "relative", lineHeight: 0 }}>
                <img src={detailFrame} alt="A frame with three proposed boxes, two of them wrong" />
                <svg
                  viewBox="0 0 1000 562"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                >
                  <rect
                    x={1}
                    y={1}
                    width={427}
                    height={560}
                    fill="none"
                    stroke="#e5326f"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                  <rect
                    x={534}
                    y={34}
                    width={312}
                    height={524}
                    fill="none"
                    stroke="#e5326f"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </div>
            </div>
            <figcaption>
              <b>Unedited output from step 02.</b> Three boxes on one frame. The left region is
              claimed by both <em>Paimon (0.20)</em> and <em>Raiden Shogun (0.17)</em>; the right
              box, <em>Paimon (0.11)</em>, is the Traveler. Two of the three labels are wrong and
              nothing is above 20% confident — which is the normal case, and the reason a person is
              still in the loop.
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="sec" id="why" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-h">
            <p className="eyebrow">Why it works</p>
            <h2>
              Checking is cheap. <span>Drawing is not.</span>
            </h2>
          </div>
          <div className="three">
            <p>
              <b>The 2023 version failed here.</b> It had a perfectly good annotation tool where
              every box was drawn from scratch, so hour ten cost exactly what hour one cost. There
              is no finish line in a job shaped like that.
            </p>
            <p>
              <b>A bad guess is still useful.</b> Rejecting one takes under a second, and a
              rejection is a label too. That is why the detector being weak is not a problem to be
              fixed before the rest can work.
            </p>
            <p>
              <b>So the model is the swappable part.</b> It sits behind a one-method interface and
              can be replaced in a single file. The pipeline, the queue and the export around it are
              the thing that was built.
            </p>
          </div>
        </div>
      </section>

      <section className="sec" style={{ paddingTop: 0 }}>
        <div className="wrap">
          {/* Design facts, not live counts. A `GET /api/public/stats` endpoint
              was built, tested and reverted on 2026-08-10: `PRD.md` §9 and
              `CONTEXT.md` §12 both exclude a public statistics surface, and
              the PRD's "checks are internal" argument reasons from that
              absence — shipping this as a live query would falsify an
              argument, not just outgrow a list (see
              memory/crowdmon-public-stats-rejected.md). These four are
              properties of the design, true at any corpus size. Do not
              re-add live counters without amending both documents first. */}
          <div className="stats">
            <div className="stat">
              <div className="v">200</div>
              <div className="l">
                frames kept per video — throughput is bounded by the human, so the queue is too
              </div>
            </div>
            <div className="stat">
              <div className="v">~2,700</div>
              <div className="l">frames a full video yields. The rest keep their rows and wait</div>
            </div>
            <div className="stat">
              <div className="v">5</div>
              <div className="l">characters recognised at a time, each one a row in a table</div>
            </div>
            <div className="stat">
              <div className="v">0</div>
              <div className="l">GPUs. Detection runs on an old desktop, on its CPU, overnight</div>
            </div>
          </div>
        </div>
      </section>

      <section className="sec" id="faq" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-h">
            <p className="eyebrow">FAQ</p>
            <h2>Questions worth asking</h2>
          </div>
          <div className="faq">
            <details open>
              <summary>Is the detector any good?</summary>
              <p className="a">
                No, and that is deliberate. It is a zero-shot bootstrap that has never seen these
                characters — confidences sit around 0.10–0.20 and plenty of its boxes are wrong,
                including one on this page. Accuracy is not the deliverable; throughput per human
                minute is.
              </p>
            </details>
            <details>
              <summary>Do verdicts on the demo change the dataset?</summary>
              <p className="a">
                Not the anonymous demo's. Those verdicts are recorded and tagged, then excluded when
                a snapshot is built — trying it out never enters the dataset. Signing in to
                contribute is different: your rulings are recorded under your own account, and count
                toward the dataset once an admin has trusted it. Admitting untrusted labels by
                default would force consensus resolution, agreement scoring and trust weighting —
                all deliberately out of scope.
              </p>
            </details>
            <details>
              <summary>Can it find something the model missed entirely?</summary>
              <p className="a">
                Not by itself. A frame with no prediction never enters the queue, so a miss looks
                identical to an absence. Admins can file missing-object reports, and the report rate
                per class is the number that says whether a prompt is working.
              </p>
            </details>
            <details>
              <summary>Does it train anything?</summary>
              <p className="a">
                Not yet. Training, a model registry and a distilled detector are all out of scope
                for now. What exists is the part that produces the data those would need.
              </p>
            </details>
            <details>
              <summary>Why Genshin Impact?</summary>
              <p className="a">
                Recognisable, consistently-rendered subjects and an endless supply of source video,
                which makes it a good harness for the pipeline. The frames are game screenshots and
                the dataset is not distributed as a product.
              </p>
            </details>
          </div>
        </div>
      </section>

      <section className="endcta">
        <h2>See it get one wrong</h2>
        <p>
          One real frame, the detector's real output, three buttons. About ten seconds, no account.
        </p>
        <div className="row">
          <Link className="btn btn-ink btn-lg" to="/verify">
            Try the demo <span className="ar">→</span>
          </Link>
          <a className="btn btn-line btn-lg" href={GITHUB}>
            Read the source
          </a>
        </div>
      </section>

      <footer className="foot">
        <div className="wrap">
          <div className="foot-g">
            <div className="foot-brand">
              <Link className="mark" to="/">
                <span className="g" />
                crowdmon
              </Link>
              <p>
                A data flywheel for object detection, built and run by one person on a home server.
              </p>
            </div>
            <div>
              <h4>Product</h4>
              <ul>
                <li>
                  <Link to="/verify">Demo</Link>
                </li>
                <li>
                  <Link to="/contribute">Contribute</Link>
                </li>
                <li>
                  <a href="#how">How it works</a>
                </li>
                <li>
                  <a href="#faq">FAQ</a>
                </li>
              </ul>
            </div>
            <div>
              <h4>Project</h4>
              <ul>
                <li>
                  <a href={GITHUB}>Source</a>
                </li>
                <li>
                  <a href={`${GITHUB}/blob/main/PRD.md`}>Scope</a>
                </li>
                <li>
                  <a href={`${GITHUB}/blob/main/ROADMAP.md`}>Roadmap</a>
                </li>
              </ul>
            </div>
            <div>
              <h4>Built with</h4>
              <ul>
                <li>
                  <a href="https://developers.cloudflare.com/workers/">Workers</a>
                </li>
                <li>
                  <a href="https://developers.cloudflare.com/d1/">D1 &amp; R2</a>
                </li>
                <li>
                  <a href="https://onnx.ai/">ONNX</a>
                </li>
              </ul>
            </div>
          </div>
          <div className="foot-b">
            <span>© 2026 crowdmon · a side project by carl</span>
            <span>Frames are game screenshots. Not affiliated with HoYoverse.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
