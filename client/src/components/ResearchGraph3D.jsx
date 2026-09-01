import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";

const RENDERER_CONFIG = {
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
};
const HIT_GEOMETRY = new THREE.SphereGeometry(1, 10, 8);
const HIT_MATERIAL = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
});
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const KEYBOARD_MOVE_SPEED = 120;

function isEditableTarget(target) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function textSprite(label, color, fontSize = 48) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = `800 ${fontSize}px Pretendard, sans-serif`;
  const padding = 22;
  const width = Math.ceil(context.measureText(label).width + padding * 2);
  canvas.width = width;
  canvas.height = fontSize + padding * 2;
  context.font = `800 ${fontSize}px Pretendard, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineWidth = 9;
  context.strokeStyle = "rgba(7, 8, 14, .92)";
  context.strokeText(label, width / 2, canvas.height / 2);
  context.fillStyle = color;
  context.fillText(label, width / 2, canvas.height / 2);

  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  const height = fontSize <= 44 ? 13 : 17;
  sprite.scale.set((width / canvas.height) * height, height, 1);
  sprite.position.set(0, 9, 0);
  return sprite;
}

export default function ResearchGraph3D({
  graph,
  visibleIds,
  visibleEdges,
  resultIds,
  selectedId,
  resetViewToken,
  labelsVisible,
  motionPaused,
  topics,
  centerX = 700,
  centerY = 430,
  relationshipReason,
  onSelect,
}) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const fittedRef = useRef(false);
  const focusedNodeRef = useRef(null);
  const keyboardFrameRef = useRef(null);
  const pressedArrowKeysRef = useRef(new Set());
  const [size, setSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!graphRef.current) return;
    if (motionPaused) graphRef.current.pauseAnimation();
    else graphRef.current.resumeAnimation();
  }, [motionPaused]);

  useEffect(() => {
    const renderer = graphRef.current?.renderer?.();
    renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
  }, [size]);

  const graphData = useMemo(() => {
    const nodes = graph.nodes
      .filter((node) => visibleIds.has(node.id))
      .map((node) => ({
        ...node,
        x: (node.x - centerX) * 0.5,
        y: (node.y - centerY) * 0.5,
        z: ((Number.parseInt(node.pmid || node.count || "0", 10) || 0) % 180) - 90,
      }));
    const links = visibleEdges.map((edge) => ({ ...edge }));
    return { nodes, links };
  }, [centerX, centerY, graph.nodes, visibleEdges, visibleIds]);

  useEffect(() => {
    fittedRef.current = false;
    focusedNodeRef.current = null;
  }, [graphData]);

  useEffect(() => {
    if (!selectedId || focusedNodeRef.current === selectedId) return;
    const node = graphData.nodes.find((candidate) => candidate.id === selectedId);
    if (!node || node.x == null) return;
    focusedNodeRef.current = selectedId;
    const vector = new THREE.Vector3(node.x || 0, node.y || 0, node.z || 0);
    if (vector.lengthSq() < 1) vector.set(0, 0, 1);
    vector.setLength(vector.length() + 120);
    graphRef.current?.cameraPosition(
      { x: vector.x, y: vector.y, z: vector.z },
      node,
      850,
    );
  }, [graphData, selectedId]);

  useEffect(() => {
    focusedNodeRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      graphRef.current?.zoomToFit(800, 48);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resetViewToken]);

  useEffect(() => {
    let lastFrameTime = null;
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const movement = new THREE.Vector3();

    const translateCamera = (horizontal, depth, distance) => {
      const instance = graphRef.current;
      const camera = instance?.camera?.();
      const controls = instance?.controls?.();
      if (!camera || !controls?.target) return;

      camera.getWorldDirection(forward);
      right.crossVectors(forward, camera.up).normalize();
      movement
        .copy(forward)
        .multiplyScalar(depth)
        .addScaledVector(right, horizontal);
      if (movement.lengthSq() === 0) return;

      movement.normalize().multiplyScalar(distance);
      camera.position.add(movement);
      controls.target.add(movement);
      controls.update?.();
      camera.updateMatrixWorld();
      instance.renderer?.()?.render(instance.scene?.(), camera);
    };

    const moveCamera = (timestamp) => {
      const pressedKeys = pressedArrowKeysRef.current;
      if (pressedKeys.size === 0) {
        keyboardFrameRef.current = null;
        lastFrameTime = null;
        return;
      }

      const elapsedSeconds = lastFrameTime == null
        ? 0
        : Math.min((timestamp - lastFrameTime) / 1000, 0.05);
      lastFrameTime = timestamp;
      if (elapsedSeconds > 0) {
        const horizontal = Number(pressedKeys.has("ArrowRight")) - Number(pressedKeys.has("ArrowLeft"));
        const depth = Number(pressedKeys.has("ArrowUp")) - Number(pressedKeys.has("ArrowDown"));
        translateCamera(horizontal, depth, KEYBOARD_MOVE_SPEED * elapsedSeconds);
      }
      keyboardFrameRef.current = window.requestAnimationFrame(moveCamera);
    };

    const handleKeyDown = (event) => {
      if (!ARROW_KEYS.has(event.key) || isEditableTarget(event.target)) return;
      event.preventDefault();
      const isNewPress = !pressedArrowKeysRef.current.has(event.key);
      pressedArrowKeysRef.current.add(event.key);
      if (isNewPress) {
        translateCamera(
          Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft"),
          Number(event.key === "ArrowUp") - Number(event.key === "ArrowDown"),
          12,
        );
      }
      if (!keyboardFrameRef.current) {
        keyboardFrameRef.current = window.requestAnimationFrame(moveCamera);
      }
    };
    const handleKeyUp = (event) => {
      if (!pressedArrowKeysRef.current.delete(event.key)) return;
      event.preventDefault();
    };
    const stopKeyboardMovement = () => {
      pressedArrowKeysRef.current.clear();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", stopKeyboardMovement);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", stopKeyboardMovement);
      pressedArrowKeysRef.current.clear();
      if (keyboardFrameRef.current) {
        window.cancelAnimationFrame(keyboardFrameRef.current);
        keyboardFrameRef.current = null;
      }
    };
  }, []);

  const topicById = useMemo(
    () => new Map(topics.map((topic) => [topic.id, topic])),
    [topics],
  );

  const nodeLabel = (node) => {
    if (node.type !== "paper") {
      return `<div class="graph-3d-tooltip"><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(node.type === "topic" ? "연구 주제" : "핵심 개념")}</span></div>`;
    }
    return [
      '<div class="graph-3d-tooltip">',
      `<span>${escapeHtml(node.identifier)}</span>`,
      `<strong>${escapeHtml(node.title)}</strong>`,
      `<small>${escapeHtml(node.year || "연도 미상")} · ${escapeHtml(topicById.get(node.topicId)?.label || "연구 분야 미상")}</small>`,
      `<p>${escapeHtml(relationshipReason(node))}</p>`,
      "</div>",
    ].join("");
  };

  const nodeObject = (node) => {
    const group = new THREE.Group();
    const hitArea = new THREE.Mesh(HIT_GEOMETRY, HIT_MATERIAL);
    const hitRadius = node.type === "topic" ? 13 : node.type === "concept" ? 9 : 6;
    hitArea.scale.setScalar(hitRadius);
    group.add(hitArea);

    const shouldShowLabel = labelsVisible
      && (node.type !== "paper" || node.id === selectedId || resultIds.has(node.id));
    if (shouldShowLabel) {
      const label = node.type === "paper" ? node.identifier : node.label;
      const color = node.type === "paper" ? "#ffffff" : node.type === "topic" ? "#8ff0df" : "#ffd0e7";
      group.add(textSprite(label, color, node.type === "paper" ? 42 : 58));
    }
    return group;
  };

  return (
    <div ref={containerRef} className="research-graph-3d" aria-label="3D PubMed 논문 지식 그래프">
      <ForceGraph3D
        ref={graphRef}
        width={size.width}
        height={size.height}
        graphData={graphData}
        rendererConfig={RENDERER_CONFIG}
        backgroundColor="#090a11"
        showNavInfo={false}
        nodeId="id"
        nodeLabel={nodeLabel}
        nodeColor={(node) => node.color || "#8b7cf6"}
        nodeVal={(node) => (
          node.type === "topic" ? 12 : node.type === "concept" ? 7 : resultIds.has(node.id) ? 4 : 1.8
        )}
        nodeOpacity={0.92}
        nodeResolution={8}
        nodeThreeObject={nodeObject}
        nodeThreeObjectExtend
        linkColor={(link) => (
          link.source?.id === selectedId || link.target?.id === selectedId
            ? "rgba(121, 225, 207, .85)"
            : link.type === "has-concept"
              ? "rgba(240, 144, 188, .28)"
              : link.type === "related"
                ? "rgba(153, 139, 246, .24)"
                : "rgba(190, 184, 215, .17)"
        )}
        linkWidth={(link) => (
          link.source?.id === selectedId || link.target?.id === selectedId ? 1.5 : 0.45
        )}
        linkOpacity={0.7}
        linkDirectionalParticles={0}
        cooldownTicks={motionPaused ? 0 : 120}
        d3AlphaDecay={0.035}
        d3VelocityDecay={0.38}
        warmupTicks={20}
        onEngineStop={() => {
          if (fittedRef.current || selectedId) return;
          fittedRef.current = true;
          graphRef.current?.zoomToFit(800, 48);
        }}
        enableNodeDrag
        enableNavigationControls
        onNodeHover={(node) => {
          if (containerRef.current) containerRef.current.style.cursor = node ? "pointer" : "grab";
        }}
        onNodeDragEnd={(node) => onSelect(node.id)}
        onNodeClick={(node) => onSelect(node.id)}
      />
      <div className="graph-3d-guide">드래그로 회전 · 휠로 확대 · 방향키로 전후·좌우 이동 · 노드를 눌러 상세 보기</div>
    </div>
  );
}
