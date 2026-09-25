import React from "react";
import { AbsoluteFill, Img, Sequence, Easing, interpolate, staticFile, useCurrentFrame } from "remotion";

const ink = "#07111b";
const cyan = "#63e7f2";
const amber = "#ffbd55";

function Background() {
  return <AbsoluteFill>
    <Img src={staticFile("workflow_illustration.png")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(4,12,20,.98) 0%, rgba(4,12,20,.90) 37%, rgba(4,12,20,.24) 76%, rgba(4,12,20,.12) 100%)" }} />
    <AbsoluteFill style={{ background: "linear-gradient(0deg, rgba(4,12,20,.65), transparent 32%)" }} />
  </AbsoluteFill>;
}

function Fade({ children, start, end = start + 18, style = {} }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [start, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, ...style }}>{children}</div>;
}

function Eyebrow({ children }) {
  return <div style={{ fontFamily: "Arial, sans-serif", color: cyan, fontSize: 22, letterSpacing: 5, fontWeight: 700, textTransform: "uppercase" }}>{children}</div>;
}

function Label({ children, color = "#e7f0f8" }) {
  return <div style={{ color, fontSize: 24, fontWeight: 600 }}>{children}</div>;
}

function FrameChrome() {
  const frame = useCurrentFrame();
  const width = interpolate(frame, [0, 450], [0, 1920], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <>
    <div style={{ position: "absolute", top: 58, left: 76, display: "flex", alignItems: "center", gap: 16, color: "#eff7fc", font: "700 23px Arial" }}>
      <div style={{ width: 11, height: 11, borderRadius: 20, background: cyan, boxShadow: `0 0 18px ${cyan}` }} /> MASTERcam MCP
    </div>
    <div style={{ position: "absolute", top: 52, right: 74, border: "1px solid rgba(99,231,242,.55)", color: cyan, padding: "12px 18px", borderRadius: 999, font: "700 15px Arial", letterSpacing: 2 }}>SAMPLE DATA DEMO</div>
    <div style={{ position: "absolute", bottom: 0, left: 0, height: 4, width, background: cyan }} />
  </>;
}

function Intro() {
  return <AbsoluteFill><Background /><Fade start={5} style={{ position: "absolute", left: 92, top: 250, width: 820 }}>
    <Eyebrow>CAM context for your assistant</Eyebrow>
    <div style={{ color: "white", font: "700 82px/1.05 Arial", marginTop: 32 }}>A clearer view<br />of the job.</div>
    <div style={{ color: "#c3d0db", font: "400 30px/1.5 Arial", marginTop: 28, maxWidth: 740 }}>Gather operation, tooling, and NC evidence in one review. Keep the operator in control.</div>
  </Fade></AbsoluteFill>;
}

function Stats() {
  return <AbsoluteFill><Background /><Fade start={8} style={{ position: "absolute", left: 92, top: 190, width: 820 }}>
    <Eyebrow>Grounded in supplied data</Eyebrow>
    <div style={{ color: "white", font: "700 64px/1.06 Arial", marginTop: 28 }}>See what the data supports.</div>
    <div style={{ display: "flex", gap: 20, marginTop: 42 }}>
      <Stat value="59" title="registered MCP tools" />
      <Stat value="7,110" title="vendor catalog records checked" />
    </div>
    <div style={{ color: "#bac8d5", font: "400 20px/1.5 Arial", marginTop: 22, maxWidth: 700 }}>Catalog coverage depends on the source. One imported catalog does not represent every tool or cutting condition.</div>
  </Fade></AbsoluteFill>;
}

function Stat({ value, title }) {
  return <div style={{ width: 320, padding: 24, background: "rgba(7,17,27,.75)", border: "1px solid rgba(99,231,242,.3)", borderRadius: 18 }}>
    <div style={{ color: cyan, font: "700 54px Arial" }}>{value}</div>
    <div style={{ color: "#e3ebf2", font: "500 19px Arial", marginTop: 8 }}>{title}</div>
  </div>;
}

function Preview() {
  return <AbsoluteFill><Background /><Fade start={7} style={{ position: "absolute", left: 92, top: 170, width: 920 }}>
    <Eyebrow>Preview before a change</Eyebrow>
    <div style={{ color: "white", font: "700 64px/1.06 Arial", marginTop: 26, maxWidth: 800 }}>Approval belongs to the operator.</div>
    <div style={{ marginTop: 36, padding: 30, borderRadius: 20, background: "rgba(7,17,27,.86)", border: "1px solid rgba(255,255,255,.16)" }}>
      <Label>Sample operation 04  ·  Feed rate</Label>
      <div style={{ display: "flex", gap: 24, alignItems: "center", marginTop: 25 }}>
        <Value title="Before" value="1,600 mm/min" />
        <div style={{ color: amber, fontSize: 36 }}>→</div>
        <Value title="Proposed" value="1,800 mm/min" accent />
      </div>
      <div style={{ color: "#afbfcb", font: "400 18px Arial", marginTop: 25 }}>Synthetic fixture preview. The live document is checked again before apply.</div>
    </div>
  </Fade></AbsoluteFill>;
}

function Value({ title, value, accent }) {
  return <div style={{ flex: 1, padding: 20, borderRadius: 14, background: accent ? "rgba(255,189,85,.12)" : "rgba(255,255,255,.05)", border: `1px solid ${accent ? "rgba(255,189,85,.48)" : "rgba(255,255,255,.1)"}` }}>
    <div style={{ color: "#aebbc8", font: "500 17px Arial" }}>{title}</div>
    <div style={{ color: accent ? amber : "white", font: "700 29px Arial", marginTop: 10 }}>{value}</div>
  </div>;
}

function Unknowns() {
  return <AbsoluteFill><Background /><Fade start={7} style={{ position: "absolute", left: 92, top: 210, width: 850 }}>
    <Eyebrow>Clear limits protect the review</Eyebrow>
    <div style={{ color: "white", font: "700 66px/1.06 Arial", marginTop: 28 }}>Unknown stays unknown.</div>
    <div style={{ marginTop: 36, display: "grid", gap: 15 }}>
      <Finding ok text="Supported straight moves and planar arcs" />
      <Finding warn text="Rotary motion requires controller review" />
      <Finding warn text="Missing work offsets skip travel checks" />
      <Finding warn text="Static review is not machine simulation" />
    </div>
    <div style={{ color: "#b9c7d3", font: "400 22px/1.45 Arial", marginTop: 28 }}>149 automated tests pass in this source branch. Licensed Mastercam acceptance remains separate.</div>
  </Fade></AbsoluteFill>;
}

function Finding({ ok, text }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "17px 22px", background: "rgba(7,17,27,.82)", border: `1px solid ${ok ? "rgba(99,231,242,.34)" : "rgba(255,189,85,.4)"}`, borderRadius: 12, color: "#e8f0f5", font: "500 23px Arial" }}>
    <div style={{ width: 12, height: 12, borderRadius: 12, background: ok ? cyan : amber }} /> {text}
  </div>;
}

export function MastercamOverview() {
  return <AbsoluteFill style={{ backgroundColor: ink }}>
    <Sequence from={0} durationInFrames={95}><Intro /></Sequence>
    <Sequence from={95} durationInFrames={100}><Stats /></Sequence>
    <Sequence from={195} durationInFrames={115}><Preview /></Sequence>
    <Sequence from={310} durationInFrames={140}><Unknowns /></Sequence>
    <FrameChrome />
  </AbsoluteFill>;
}
