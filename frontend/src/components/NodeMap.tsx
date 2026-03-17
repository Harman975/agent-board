import React, { useEffect, useState, useMemo } from 'react';
import ReactFlow, {
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  Background,
  Controls,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { ImportGraphData } from '../types';

const AGENT_COLORS: Record<string, string> = {
  '@p1-server': '#388bfd',
  '@p2-frontend': '#d29922',
  '@p3-tests': '#3fb950',
  '@p4-docs': '#f85149',
};

function nodeColor(size: number, maxSize: number, agent?: string): string {
  if (agent && AGENT_COLORS[agent]) {
    return AGENT_COLORS[agent];
  }
  const intensity = Math.min(size / Math.max(maxSize, 1), 1);
  const r = Math.round(56 + intensity * 100);
  const g = Math.round(139 + intensity * -80);
  const b = Math.round(253);
  return `rgb(${r}, ${g}, ${b})`;
}

export const NodeMap: React.FC = () => {
  const [graphData, setGraphData] = useState<ImportGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchGraph = async () => {
      try {
        const res = await fetch('/data/import-graph');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ImportGraphData = await res.json();
        setGraphData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load graph');
      } finally {
        setLoading(false);
      }
    };
    fetchGraph();
  }, []);

  const maxSize = useMemo(() => {
    if (!graphData) return 0;
    return Math.max(...graphData.nodes.map((n) => n.size), 1);
  }, [graphData]);

  const initialNodes: Node[] = useMemo(() => {
    if (!graphData) return [];
    const cols = Math.ceil(Math.sqrt(graphData.nodes.length));
    return graphData.nodes.map((n, i) => ({
      id: n.id,
      data: {
        label: (
          <div className="nodemap-node-label">
            <span className="nodemap-file">{n.file}</span>
            <span className="nodemap-size">{n.size}B</span>
            {n.agent && <span className="nodemap-agent">{n.agent}</span>}
          </div>
        ),
      },
      position: {
        x: (i % cols) * 220,
        y: Math.floor(i / cols) * 120,
      },
      style: {
        background: nodeColor(n.size, maxSize, n.agent),
        color: '#fff',
        border: '1px solid #30363d',
        borderRadius: '6px',
        padding: '8px 12px',
        fontSize: '12px',
        minWidth: '160px',
      },
    }));
  }, [graphData, maxSize]);

  const initialEdges: Edge[] = useMemo(() => {
    if (!graphData) return [];
    return graphData.edges.map((e, i) => ({
      id: `e-${i}`,
      source: e.source,
      target: e.target,
      animated: true,
      style: { stroke: '#8b949e' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#8b949e' },
    }));
  }, [graphData]);

  const [, , onNodesChange] = useNodesState(initialNodes);
  const [, , onEdgesChange] = useEdgesState(initialEdges);

  if (loading) {
    return <div className="nodemap-loading">Loading architecture graph...</div>;
  }

  if (error) {
    return <div className="nodemap-error">Error: {error}</div>;
  }

  if (!graphData || graphData.nodes.length === 0) {
    return <div className="nodemap-empty">No import graph data available.</div>;
  }

  return (
    <div className="nodemap-container">
      <ReactFlow
        nodes={initialNodes}
        edges={initialEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        attributionPosition="bottom-left"
      >
        <Background color="#30363d" gap={20} />
        <Controls />
      </ReactFlow>
    </div>
  );
};
