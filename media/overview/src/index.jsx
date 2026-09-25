import React from "react";
import { registerRoot } from "remotion";
import { Composition } from "remotion";
import { MastercamOverview } from "./video.jsx";

function Root() {
  return <Composition id="MastercamOverview" component={MastercamOverview} durationInFrames={450} fps={30} width={1920} height={1080} />;
}

registerRoot(Root);
