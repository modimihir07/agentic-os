import { lazy } from "react";
import { Network } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "agent-nodes",
  title: "Agent Nodes",
  description: "Dispatcher sub-agents, LLM providers (local/cloud) and Agentic OS agent health.",
  icon: Network,
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 3, h: 2 },
  defaultConfig: {},
  component: lazy(() => import("./AgentNodes")),
});
