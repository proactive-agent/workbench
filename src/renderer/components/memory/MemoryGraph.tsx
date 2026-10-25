import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
// The app's Content Security Policy forbids eval; this makes PixiJS build its shaders without it
import 'pixi.js/unsafe-eval';
import { Application, Circle, Color, Container, Graphics, Text } from 'pixi.js';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import { useSettingsStore } from '../../stores/settings-store';
import type { GraphifyGraph, GraphifyGraphNode } from '../../../shared/types/cli';
import type { LayoutMessage, LayoutRequest } from './graph-layout.worker';
import { communityColorIndex, GRAPHIFY_COMMUNITY_COLORS } from './graphify-colors';
import { labelledNodes } from './graph-labels';

interface ViewNode extends GraphifyGraphNode {
  index: number;
  radius: number;
  connections: number;
  /** Index into Graphify's community palette */
  colorIndex: number;
}

/** Graphify's community colors, built once */
const PALETTE = GRAPHIFY_COMMUNITY_COLORS.map((hex) => new Color(hex));
/** Graphify's hovered-node fill */
const HIGHLIGHT_FILL = new Color('#ffffff');
/** Graphify's link opacity when hovered: extracted links 0.7, inferred (and others) 0.35 */
const HOVER_LINK_ALPHA = { extracted: 0.7, inferred: 0.35 };

/** Camera distance from the graph's center, in graph radii (smaller exaggerates perspective) */
const CAMERA_DISTANCE = 3;
/** How fast a released spin slows down (ms for it to drop to about a third) */
const SPIN_DECAY_MS = 300;
/** Untouched for this long, the view zooms back to fit the graph and starts turning slowly */
const IDLE_RESET_MS = 5000;
/** Idle turning speed (radians per ms: a full turn in about 40 seconds) */
const AUTO_ROTATE_SPEED = 0.00016;
/** How long the zoom takes to ease back to the fitted view */
const ZOOM_RESET_MS = 1000;

/** Theme colors from the page's CSS, re-read when the appearance changes */
function readColors() {
  const body = getComputedStyle(document.body);
  const root = getComputedStyle(document.documentElement);
  const text = new Color(body.color);
  return {
    // Colorful style: node and link colors come from Graphify's palette, the same in light and
    // dark. Links are much fainter than Graphify's 0.7 / 0.35 (kept as a 2:1 ratio) because
    // thousands overlap in 3D.
    linkAlpha: { extracted: 0.08, inferred: 0.04 },
    dimmedLinkAlpha: 0.03,
    // Plain style: nodes in the muted label grey (in 3D many overlap, and the text color added up
    // too bright), links in the text color; a hovered neighbourhood lights up in the primary color
    plain: {
      node: new Color(root.getPropertyValue('--nav-label-color').trim() || body.color),
      nodeAlpha: 0.5,
      accent: new Color(root.getPropertyValue('--primary').trim() || body.color),
      link: text,
      linkAlpha: 0.035,
      dimmedLinkAlpha: 0.02,
    },
    text,
    font: body.fontFamily,
  };
}

/** "." -> ".." -> "..." in a fixed width, so the text before it doesn't move */
function LoadingDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const timer = setInterval(() => setCount((current) => (current % 3) + 1), 400);
    return () => clearInterval(timer);
  }, []);
  return <span className="inline-block w-[3ch] text-left">{'.'.repeat(count)}</span>;
}

/**
 * Obsidian-style graph view of the project's memory graph (Graphify's graph.json). Like Obsidian,
 * the force layout runs in a Web Worker (in 3D, with d3-force-3d) and PixiJS draws the graph with
 * WebGL. Nodes and links are colored by community with Graphify's own palette, or drawn in one muted
 * color (Settings > Appearance > Graph style). Drag the background to turn the graph like a globe
 * (it keeps spinning when flicked), wheel to zoom, Shift+drag to pan, drag nodes to move them and hover to highlight a node's neighbours and show their names.
 * Left alone, the graph turns slowly, and 5 seconds after the last touch the view resets to it.
 */
export function MemoryGraph({ projectId }: { projectId: string }) {
  const { t } = useTranslation('navigation');
  const containerRef = useRef<HTMLDivElement>(null);
  const revision = useMemoryGraphStore((state) => state.revision[projectId] ?? 0);
  const [graph, setGraph] = useState<GraphifyGraph | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  // False until the first layout of the loaded graph is drawn
  const [laidOut, setLaidOut] = useState(false);
  // Graph style: switching it redraws the graph in place (no new layout)
  const colorful = useSettingsStore((state) => state.settings.graphStyle ?? 'plain') === 'colorful';
  const colorfulRef = useRef(colorful);
  const restyleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    colorfulRef.current = colorful;
    restyleRef.current?.();
  }, [colorful]);

  // Load the graph (again after a rebuild)
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    window.electronAPI.getGraphifyGraph(projectId).then((result) => {
      if (cancelled) return;
      if (!result.success) {
        setStatus('error');
      } else if (!result.data || result.data.nodes.length === 0) {
        setStatus('empty');
      } else {
        setGraph(result.data);
        setStatus('ready');
      }
    }).catch(() => {
      if (!cancelled) setStatus('error');
    });
    return () => { cancelled = true; };
  }, [projectId, revision]);

  // Lay it out and draw it
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !graph || status !== 'ready') return;

    setLaidOut(false);
    let disposed = false;
    let app: Application | null = null;
    let zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
    let themeObserver: MutationObserver | null = null;
    const worker = new Worker(new URL('./graph-layout.worker.ts', import.meta.url), { type: 'module' });
    const send = (request: LayoutRequest) => worker.postMessage(request);

    // Graph data: sizes by number of connections
    const indexById = new Map(graph.nodes.map((node, i) => [node.id, i]));
    const neighbours: Array<Set<number>> = graph.nodes.map(() => new Set());
    const linkPairs: Array<[number, number]> = [];
    // Like Graphify, a link takes its source node's community color and is fainter unless extracted.
    // Link indexes grouped by (palette index * 2 + inferred), so each group is stroked once.
    const linkGroups: number[][] = PALETTE.flatMap(() => [[], []]);
    for (const link of graph.links) {
      const source = indexById.get(link.source);
      const target = indexById.get(link.target);
      if (source === undefined || target === undefined) continue;
      const group = communityColorIndex(graph.nodes[source].community) * 2
        + (link.confidence === undefined || link.confidence === 'EXTRACTED' ? 0 : 1);
      linkGroups[group].push(linkPairs.length);
      linkPairs.push([source, target]);
      neighbours[source].add(target);
      neighbours[target].add(source);
    }
    const nodes: ViewNode[] = graph.nodes.map((node, index) => {
      const connections = neighbours[index].size;
      return {
        ...node,
        index,
        connections,
        radius: Math.min(2.5 + Math.sqrt(connections) * 1.1, 16),
        colorIndex: communityColorIndex(node.community),
      };
    });
    // Layout positions from the worker [x, y, z, ...], and their projection on screen (world
    // container coordinates), depth (positive toward the viewer) and perspective scale
    let positions: Float32Array<ArrayBufferLike> = new Float32Array(nodes.length * 3);
    const projectedX = new Float32Array(nodes.length);
    const projectedY = new Float32Array(nodes.length);
    const depth = new Float32Array(nodes.length);
    const perspective = new Float32Array(nodes.length).fill(1);
    let graphRadius = 1;
    // Rotation applied to the layout (row-major 3x3), changed by dragging the background
    let rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];

    let dirty = false;

    const setup = async () => {
      const pixi = new Application();
      await pixi.init({
        resizeTo: container,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });
      if (disposed) {
        pixi.destroy(true, { children: true });
        return;
      }
      app = pixi;
      container.appendChild(pixi.canvas);
      pixi.canvas.style.display = 'block';

      // Scene: a world container (zoomed and panned) with links under nodes under labels
      const world = new Container();
      const linkLayer = new Graphics();
      const nodeLayer = new Container();
      // Nodes nearer the viewer draw (and take the pointer) over those behind them
      nodeLayer.sortableChildren = true;
      const labelLayer = new Container();
      world.addChild(linkLayer, nodeLayer, labelLayer);
      // Hidden until the first layout arrives and is fitted
      world.visible = false;
      pixi.stage.addChild(world);

      let colors = readColors();
      let hovered: ViewNode | null = null;
      let dragged: ViewNode | null = null;
      let dragMoved = false;
      let transform: ZoomTransform = zoomIdentity;
      let userMoved = false;
      const nodeGraphics: Graphics[] = [];
      const labels = new Map<number, Text>();

      // Colorful: nodes are colored by community like Graphify's graph view; the hovered node turns
      // white with a ring in its community color (Graphify's highlight), the rest of its
      // neighbourhood stays lit. Plain: every node in the muted grey; a hovered node and its
      // neighbours light up in the primary color at half opacity
      const isLit = (index: number) =>
        !!hovered && (hovered.index === index || neighbours[hovered.index].has(index));
      const drawNode = (node: ViewNode) => {
        const shape = nodeGraphics[node.index].clear().circle(0, 0, node.radius);
        if (!colorfulRef.current) {
          const { plain } = colors;
          shape.fill(isLit(node.index) ? { color: plain.accent, alpha: 0.5 } : { color: plain.node, alpha: plain.nodeAlpha });
          return;
        }
        const color = PALETTE[node.colorIndex];
        if (hovered?.index === node.index) {
          shape.fill(HIGHLIGHT_FILL).stroke({ width: 1.5, color });
        } else {
          shape.fill(color);
        }
      };

      for (const node of nodes) {
        const g = new Graphics();
        g.eventMode = 'static';
        g.cursor = 'pointer';
        g.hitArea = new Circle(0, 0, node.radius + 3);
        g.on('pointerover', () => { if (!dragged) setHovered(node); });
        g.on('pointerout', () => { if (!dragged) setHovered(null); });
        g.on('pointerdown', (event) => {
          event.stopPropagation();
          spin = null;
          dragged = node;
          dragMoved = false;
        });
        nodeGraphics.push(g);
        nodeLayer.addChild(g);
        drawNode(node);
      }

      const inFocus = (index: number) =>
        !hovered || hovered.index === index || neighbours[hovered.index].has(index);

      const labelFor = (node: ViewNode) => {
        let label = labels.get(node.index);
        if (!label) {
          label = new Text({
            text: node.label,
            style: { fontFamily: colors.font, fontSize: 11, fill: colors.text },
            resolution: 2,
          });
          label.anchor.set(0.5, 0);
          label.alpha = 0.8;
          label.eventMode = 'none';
          labels.set(node.index, label);
          labelLayer.addChild(label);
        }
        return label;
      };

      // Names only for the hovered neighbourhood (none without a hovered node)
      const updateLabels = () => {
        const k = transform.k;
        const show = labelledNodes(hovered?.index ?? null, neighbours);
        for (const [index, label] of labels) {
          if (!show.has(index)) label.visible = false;
        }
        for (const index of show) {
          const node = nodes[index];
          const label = labelFor(node);
          label.visible = true;
          label.scale.set(1 / Math.max(k, 1));
          const nodeScale = (k > 1 ? 1 / Math.sqrt(k) : 1) * perspective[index];
          label.position.set(projectedX[index], projectedY[index] + node.radius * nodeScale + 2 / Math.max(k, 1));
        }
      };

      // Plain: every link in the text color; with a hovered node every link dims and its own links
      // are drawn on top in the primary color
      const drawPlainLinks = (width: number) => {
        const { plain } = colors;
        for (const [s, t] of linkPairs) {
          linkLayer.moveTo(projectedX[s], projectedY[s]).lineTo(projectedX[t], projectedY[t]);
        }
        linkLayer.stroke({ width, color: plain.link, alpha: hovered ? plain.dimmedLinkAlpha : plain.linkAlpha });
        if (!hovered) return;
        for (const [s, t] of linkPairs) {
          if (s !== hovered.index && t !== hovered.index) continue;
          linkLayer.moveTo(projectedX[s], projectedY[s]).lineTo(projectedX[t], projectedY[t]);
        }
        linkLayer.stroke({ width: width * 1.5, color: plain.accent, alpha: 0.5 });
      };

      const drawLinks = () => {
        linkLayer.clear();
        const width = 1 / transform.k;
        if (!colorfulRef.current) {
          drawPlainLinks(width);
          return;
        }
        // One stroke per (community color, extracted or not) group; with a hovered node every link
        // dims first and the node's own links are drawn on top at Graphify's opacities
        const strokeGroup = (group: number, only: ((s: number, t: number) => boolean) | null, lineWidth: number, alpha: number) => {
          let any = false;
          for (const link of linkGroups[group]) {
            const [s, t] = linkPairs[link];
            if (only && !only(s, t)) continue;
            linkLayer.moveTo(projectedX[s], projectedY[s]).lineTo(projectedX[t], projectedY[t]);
            any = true;
          }
          if (any) linkLayer.stroke({ width: lineWidth, color: PALETTE[group >> 1], alpha });
        };
        for (let group = 0; group < linkGroups.length; group++) {
          const inferred = group & 1;
          strokeGroup(group, null, width, hovered
            ? colors.dimmedLinkAlpha
            : inferred ? colors.linkAlpha.inferred : colors.linkAlpha.extracted);
        }
        if (hovered) {
          const index = hovered.index;
          for (let group = 0; group < linkGroups.length; group++) {
            strokeGroup(group, (s, t) => s === index || t === index, width * 1.5,
              group & 1 ? HOVER_LINK_ALPHA.inferred : HOVER_LINK_ALPHA.extracted);
          }
        }
      };

      // Rotate the layout and project it with perspective
      const project = () => {
        const [a, b, c, d, e, f, g, h, i] = rotation;
        const camera = graphRadius * CAMERA_DISTANCE;
        for (let n = 0; n < nodes.length; n++) {
          const x = positions[n * 3], y = positions[n * 3 + 1], z = positions[n * 3 + 2];
          const rx = a * x + b * y + c * z;
          const ry = d * x + e * y + f * z;
          const rz = g * x + h * y + i * z;
          const scale = camera / Math.max(camera - rz, camera * 0.1);
          projectedX[n] = rx * scale;
          projectedY[n] = ry * scale;
          depth[n] = rz;
          perspective[n] = scale;
        }
      };

      const render = () => {
        project();
        // Zoomed in, nodes grow slower than the distances between them (like Obsidian)
        const nodeScale = transform.k > 1 ? 1 / Math.sqrt(transform.k) : 1;
        for (const node of nodes) {
          const g = nodeGraphics[node.index];
          g.position.set(projectedX[node.index], projectedY[node.index]);
          g.scale.set(nodeScale * perspective[node.index]);
          g.zIndex = depth[node.index];
          // Fade the far side of the globe
          const nearness = Math.min(Math.max((depth[node.index] + graphRadius) / (2 * graphRadius), 0), 1);
          g.alpha = (inFocus(node.index) ? 1 : 0.15) * (0.25 + 0.75 * nearness);
        }
        drawLinks();
        updateLabels();
      };

      function setHovered(node: ViewNode | null) {
        const redraw = (around: ViewNode | null) => {
          if (!around) return;
          drawNode(around);
          for (const index of neighbours[around.index]) drawNode(nodes[index]);
        };
        const previous = hovered;
        hovered = node;
        redraw(previous);
        redraw(node);
        dirty = true;
      }

      // Zoom with the wheel and pan with Shift+drag through d3-zoom (dragging turns the graph)
      const canvas = pixi.canvas as HTMLCanvasElement;
      zoomBehavior = zoom<HTMLCanvasElement, unknown>()
        .scaleExtent([0.02, 8])
        .filter((event: MouseEvent) =>
          !dragged && (event.type === 'wheel' || (event.type === 'mousedown' && event.shiftKey && !hovered)))
        .on('zoom', (event) => {
          if (event.sourceEvent) {
            userMoved = true;
            markInteraction();
          }
          transform = event.transform;
          world.position.set(transform.x, transform.y);
          world.scale.set(transform.k);
          dirty = true;
        });
      const canvasSelection = select<HTMLCanvasElement, unknown>(canvas);
      canvasSelection.call(zoomBehavior).on('dblclick.zoom', null);

      // Center the graph and zoom so it fills the page
      // Zoom so the sphere around the graph's center that holds every node fits the page, centered:
      // it fits whichever way the graph is turned, so turning never changes the zoom
      const fitTransform = () => {
        const camera = graphRadius * CAMERA_DISTANCE;
        // Projected radius of that sphere under the perspective, plus room for the largest node
        const extent = (graphRadius * camera) / Math.sqrt(camera * camera - graphRadius * graphRadius) + 16;
        const k = Math.min((Math.min(pixi.screen.width, pixi.screen.height) / 2 / extent) * 0.97, 2);
        return zoomIdentity.translate(pixi.screen.width / 2, pixi.screen.height / 2).scale(k);
      };
      const fitToView = () => canvasSelection.call(zoomBehavior!.transform, fitTransform());

      // Idle animation: the graph turns slowly until it is touched, and 5 seconds after the last
      // touch the zoom eases back to the fitted view and the turning starts again
      let autoRotating = true;
      let lastInteraction = performance.now();
      let zoomReset: { from: ZoomTransform; to: ZoomTransform; start: number } | null = null;
      function markInteraction() {
        lastInteraction = performance.now();
        autoRotating = false;
        zoomReset = null;
      }
      canvas.addEventListener('pointerdown', markInteraction);

      worker.onmessage = (event: MessageEvent<LayoutMessage>) => {
        positions = event.data.positions;
        graphRadius = 1;
        for (let i = 0; i < nodes.length; i++) {
          graphRadius = Math.max(graphRadius, Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
        }
        // Keep the graph in view while it spreads out, until the user zooms or pans
        if (!userMoved && !zoomReset) fitToView();
        if (!world.visible) {
          world.visible = true;
          setLaidOut(true);
        }
        dirty = true;
      };
      send({ type: 'init', count: nodes.length, links: linkPairs });

      // Turning the graph like a globe: the surface follows the pointer, and a flick keeps spinning
      let rotating = false;
      let lastPointer = { x: 0, y: 0, time: 0 };
      let velocity = { x: 0, y: 0 };
      let spin: { x: number; y: number } | null = null;
      // Turn by an angle around an on-screen axis (ux, uy, 0) of unit length (Rodrigues' formula)
      const turnBy = (ux: number, uy: number, angle: number) => {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const t = 1 - cos;
        const turn = [
          t * ux * ux + cos, t * ux * uy, uy * sin,
          t * ux * uy, t * uy * uy + cos, -ux * sin,
          -uy * sin, ux * sin, cos,
        ];
        const next = new Array<number>(9);
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 3; col++) {
            next[row * 3 + col] = turn[row * 3] * rotation[col] + turn[row * 3 + 1] * rotation[3 + col] + turn[row * 3 + 2] * rotation[6 + col];
          }
        }
        rotation = next;
        dirty = true;
      };
      // Turn around the on-screen axis perpendicular to a drag, the surface following the pointer
      const rotateBy = (dx: number, dy: number) => {
        const length = Math.hypot(dx, dy);
        if (length === 0) return;
        turnBy(-dy / length, dx / length, length / (transform.k * graphRadius));
      };
      const cursorStyles = pixi.renderer.events.cursorStyles;
      cursorStyles.default = 'grab';
      canvas.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.shiftKey || dragged || hovered) return;
        rotating = true;
        spin = null;
        velocity = { x: 0, y: 0 };
        lastPointer = { x: event.clientX, y: event.clientY, time: performance.now() };
        canvas.setPointerCapture(event.pointerId);
        cursorStyles.default = 'grabbing';
        canvas.style.cursor = 'grabbing';
      });
      canvas.addEventListener('pointermove', (event) => {
        if (!rotating) return;
        const now = performance.now();
        const dx = event.clientX - lastPointer.x;
        const dy = event.clientY - lastPointer.y;
        // Browsers can send a move without movement right before the release; it isn't a stop
        if (dx === 0 && dy === 0) return;
        const elapsed = Math.max(now - lastPointer.time, 1);
        // Smoothed, so one uneven move doesn't decide the spin
        velocity = { x: velocity.x * 0.5 + (dx / elapsed) * 0.5, y: velocity.y * 0.5 + (dy / elapsed) * 0.5 };
        lastPointer = { x: event.clientX, y: event.clientY, time: now };
        rotateBy(dx, dy);
      });
      const endRotate = (event: PointerEvent) => {
        if (!rotating) return;
        rotating = false;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        cursorStyles.default = 'grab';
        canvas.style.cursor = 'grab';
        // Keep spinning when released mid-flick
        if (performance.now() - lastPointer.time < 100 && Math.hypot(velocity.x, velocity.y) > 0.05) spin = velocity;
      };
      canvas.addEventListener('pointerup', endRotate);
      canvas.addEventListener('pointercancel', endRotate);

      // Draw at most once per frame, only when something changed
      pixi.ticker.add((ticker) => {
        const now = performance.now();
        if (hovered || rotating || dragged || spin) lastInteraction = now;
        if (!autoRotating && now - lastInteraction > IDLE_RESET_MS) {
          autoRotating = true;
          userMoved = false;
          zoomReset = { from: transform, to: fitTransform(), start: now };
        }
        if (zoomReset) {
          const t = Math.min((now - zoomReset.start) / ZOOM_RESET_MS, 1);
          const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          const { from, to } = zoomReset;
          canvasSelection.call(
            zoomBehavior!.transform,
            zoomIdentity
              .translate(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased)
              .scale(from.k + (to.k - from.k) * eased)
          );
          if (t === 1) zoomReset = null;
        }
        // Pause while a node is hovered, so it stays under the pointer
        if (autoRotating && !hovered) turnBy(0, 1, AUTO_ROTATE_SPEED * ticker.deltaMS);
        if (spin) {
          rotateBy(spin.x * ticker.deltaMS, spin.y * ticker.deltaMS);
          const decay = Math.exp(-ticker.deltaMS / SPIN_DECAY_MS);
          spin = { x: spin.x * decay, y: spin.y * decay };
          if (Math.hypot(spin.x, spin.y) < 0.01) spin = null;
        }
        if (!dirty) return;
        dirty = false;
        render();
      });

      // Dragging nodes
      pixi.stage.eventMode = 'static';
      pixi.stage.hitArea = pixi.screen;
      pixi.stage.on('pointermove', (event) => {
        if (!dragged) return;
        dragMoved = true;
        // Move the node in the screen plane at its current depth: undo the perspective and rotation
        const point = world.toLocal(event.global);
        const index = dragged.index;
        const rx = point.x / perspective[index];
        const ry = point.y / perspective[index];
        const rz = depth[index];
        send({
          type: 'drag',
          index,
          x: rotation[0] * rx + rotation[3] * ry + rotation[6] * rz,
          y: rotation[1] * rx + rotation[4] * ry + rotation[7] * rz,
          z: rotation[2] * rx + rotation[5] * ry + rotation[8] * rz,
        });
      });
      const endDrag = () => {
        if (!dragged) return;
        const node = dragged;
        dragged = null;
        if (dragMoved) send({ type: 'release', index: node.index });
      };
      pixi.stage.on('pointerup', endDrag);
      pixi.stage.on('pointerupoutside', endDrag);

      // Follow the theme (light/dark)
      // Theme or graph style changed: redraw with the new colors
      const restyle = () => {
        colors = readColors();
        for (const node of nodes) drawNode(node);
        for (const label of labels.values()) label.style.fill = colors.text;
        dirty = true;
      };
      restyleRef.current = restyle;
      themeObserver = new MutationObserver(restyle);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    };

    void setup();

    return () => {
      disposed = true;
      restyleRef.current = null;
      themeObserver?.disconnect();
      send({ type: 'stop' });
      worker.terminate();
      if (zoomBehavior) zoomBehavior.on('zoom', null);
      if (app) {
        select(app.canvas as HTMLCanvasElement).on('.zoom', null);
        app.destroy(true, { children: true });
      }
    };
  }, [graph, status]);

  return (
    <div className="relative flex h-full flex-col">
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        {(status !== 'ready' || !laidOut) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-(--nav-label-color)">
            {(status === 'loading' || status === 'ready') && <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.75} />}
            {/* The left padding balances the dots, so the words stay centered under the icon */}
            {status === 'loading' && <span className="pl-[3ch]">{t('memoryGraph.loading')}<LoadingDots /></span>}
            {status === 'ready' && graph && (
              <span className="pl-[3ch]">
                {t('memoryGraph.layingOut', {
                  nodes: graph.nodes.length.toLocaleString(),
                  links: graph.links.length.toLocaleString(),
                })}
                <LoadingDots />
              </span>
            )}
            {status === 'empty' && t('memoryGraph.empty')}
            {status === 'error' && t('memoryGraph.loadFailed')}
          </div>
        )}
      </div>
    </div>
  );
}
