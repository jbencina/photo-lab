import React, {type ReactNode} from 'react';
import styles from './styles.module.css';

// One diagram, drawn twice: a wide layout for desktop and tablet, and a tall one for phones (the wide one
// would shrink its text to about 5 px on a phone). The CSS module shows one or the other by width.

type Line = ReactNode | [ReactNode, ReactNode];

const LINE = 15;

const ICONS: Record<string, ReactNode> = {
  // Lucide icons (ISC license), the same set the web UI uses.
  folder: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  cpu: (
    <>
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </>
  ),
  sparkles: (
    <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" />
  ),
  image: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
    </>
  ),
  devices: (
    <>
      <path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" />
      <path d="M10 19v-4M7 19h5" />
      <rect width="6" height="10" x="16" y="12" rx="2" />
    </>
  ),
};

function Icon({name, x, y}: {name: string; x: number; y: number}) {
  return (
    <g className={styles.icon} transform={`translate(${x} ${y}) scale(0.667)`}>
      {ICONS[name]}
    </g>
  );
}

function Panel(p: {x: number; y: number; w: number; h: number; label: string; sub: ReactNode; model?: boolean}) {
  return (
    <g>
      <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={12} className={p.model ? styles.modelPanel : styles.panel} />
      <text x={p.x + 14} y={p.y + 22} className={p.model ? styles.modelLabel : styles.panelLabel}>
        {p.label.toUpperCase()}
      </text>
      <text x={p.x + 14} y={p.y + 38} className={styles.muted}>
        {p.sub}
      </text>
    </g>
  );
}

function Card(p: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: ReactNode;
  icon?: string;
  step?: number;
  lines?: Line[];
  foot?: string | string[];
  compact?: boolean;
  model?: boolean;
}) {
  const top = p.compact ? 19 : 23;
  const first = p.compact ? 36 : 42;
  const tx = p.icon || p.step ? p.x + 34 : p.x + 12;
  return (
    <g>
      <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={8} className={p.model ? styles.modelCard : styles.card} />
      {p.icon && <Icon name={p.icon} x={p.x + 11} y={p.y + top - 12} />}
      {p.step && (
        <>
          <circle cx={p.x + 20} cy={p.y + top - 4} r={9} className={styles.stepDot} />
          <text x={p.x + 20} y={p.y + top} textAnchor="middle" className={styles.stepNum}>
            {p.step}
          </text>
        </>
      )}
      <text x={tx} y={p.y + top} className={styles.title}>
        {p.title}
      </text>
      {p.lines?.map((line, i) => {
        const y = p.y + first + i * LINE;
        return Array.isArray(line) ? (
          <g key={i}>
            <text x={p.x + 12} y={y} className={styles.body}>
              {line[0]}
            </text>
            <text x={p.x + p.w / 2 + 4} y={y} className={styles.body}>
              {line[1]}
            </text>
          </g>
        ) : (
          <text key={i} x={p.x + 12} y={y} className={styles.body}>
            {line}
          </text>
        );
      })}
      {[p.foot ?? []].flat().map((t, i, all) => (
        <text key={t} x={p.x + 12} y={p.y + p.h - 12 - (all.length - 1 - i) * 14} className={styles.muted}>
          {t}
        </text>
      ))}
    </g>
  );
}

/** The SQLite file, drawn as a cylinder with its main tables in two columns. */
function Database({x, y, w, h, colGap}: {x: number; y: number; w: number; h: number; colGap: number}) {
  const ry = 9;
  const rx = w / 2;
  const body = `M${x} ${y + ry} V${y + h - ry} A${rx} ${ry} 0 0 0 ${x + w} ${y + h - ry} V${y + ry}`;
  const cols = [
    ['Photos, EXIF', 'Embeddings', 'Palettes'],
    ['Subjects, labels', 'Likes', 'FTS5 text index'],
  ];
  return (
    <g>
      <path d={`${body} Z`} className={styles.card} />
      <ellipse cx={x + rx} cy={y + ry} rx={rx} ry={ry} className={styles.card} />
      <text x={x + 14} y={y + 40} className={styles.title}>
        <tspan className={styles.mono}>photolib.db</tspan>
        <tspan className={styles.muted} dx={6}>
          SQLite
        </tspan>
      </text>
      {cols.map((col, c) =>
        col.map((t, i) => (
          <text key={`${c}${i}`} x={x + 14 + c * colGap} y={y + 62 + i * LINE} className={styles.body}>
            {t}
          </text>
        )),
      )}
    </g>
  );
}

function Thumbs({x, y, w, h}: {x: number; y: number; w: number; h: number}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} className={styles.card} />
      <Icon name="image" x={x + 11} y={y + h / 2 - 8} />
      <text x={x + 34} y={y + h / 2 + 4} className={styles.title}>
        <tspan className={styles.mono}>thumbs/</tspan>
        <tspan className={styles.muted} dx={6}>
          640 px WebP
        </tspan>
      </text>
    </g>
  );
}

function Arrow({d, model, both, id}: {d: string; model?: boolean; both?: boolean; id: string}) {
  const marker = `url(#${id}-${model ? 'model' : 'flow'})`;
  return <path d={d} className={model ? styles.modelArrow : styles.arrow} markerEnd={marker} markerStart={both ? marker : undefined} />;
}

function Label(p: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: 'start' | 'middle' | 'end';
  rotate?: boolean;
  onPanel?: boolean;
}) {
  return (
    <text
      x={p.x}
      y={p.y}
      textAnchor={p.anchor ?? 'start'}
      transform={p.rotate ? `rotate(-90 ${p.x} ${p.y})` : undefined}
      className={p.onPanel ? `${styles.edgeLabel} ${styles.onPanel}` : styles.edgeLabel}>
      {p.children}
    </text>
  );
}

function Markers({id}: {id: string}) {
  return (
    <defs>
      {(['flow', 'model'] as const).map((kind) => (
        <marker
          key={kind}
          id={`${id}-${kind}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse">
          <path d="M1 1.5 9 5 1 8.5z" className={kind === 'flow' ? styles.headFlow : styles.headModel} />
        </marker>
      ))}
    </defs>
  );
}

function Legend({x, y, id}: {x: number; y: number; id: string}) {
  return (
    <g>
      <Arrow id={id} d={`M${x} ${y} h34`} />
      <text x={x + 46} y={y + 4} className={styles.body}>
        Photos and index data
      </text>
      <Arrow id={id} model d={`M${x} ${y + 24} h34`} />
      <text x={x + 46} y={y + 28} className={styles.body}>
        Model calls (in-process, or HTTP to a URL)
      </text>
    </g>
  );
}

const SERVE = (
  <>
    <tspan className={styles.mono}>photolib serve</tspan> (FastAPI)
  </>
);
const REFRESH = (
  <>
    <tspan className={styles.mono}>photolib refresh</tspan>, or Admin → Refresh
  </>
);
const INDEX_DIR = <tspan className={styles.mono}>data/catalogs/&lt;folder&gt;-&lt;hash&gt;/</tspan>;
const EMBED_LINES = ['EXIF, thumbnail, color palette', 'Image embedding (768-d)'];
const TAG_LINES = ['Top 20 labels by embedding', 'd1-3B keeps P(yes) ≥ 0.8'];
const TITLE = 'photo-lib system overview';
const DESC =
  'The indexer reads new JPEGs from the photo folder, embeds them with EmbeddingGemma 2 and tags them with d1-3B, ' +
  'and writes the results to a SQLite index with thumbnails. The server reads and writes that index, keeps the ' +
  'vectors in memory, calls the models for search and tagging jobs, and serves the web UI, thumbnails and originals ' +
  'to browsers on the LAN.';

function Wide() {
  const id = 'sd-wide';
  return (
    <svg viewBox="0 0 840 780" className={styles.wide} role="img" aria-labelledby={`${id}-t ${id}-d`}>
      <title id={`${id}-t`}>{TITLE}</title>
      <desc id={`${id}-d`}>{DESC}</desc>
      <Markers id={id} />

      <Card x={20} y={88} w={200} h={90} icon="folder" title="Photo folder" lines={['JPEG originals, read-only']} foot="Scanned for new files" />

      <Panel x={290} y={40} w={240} h={270} label="Indexing" sub={REFRESH} />
      <Card x={304} y={88} w={212} h={90} step={1} title="Embed pass" lines={EMBED_LINES} foot="14.5 photos/s" />
      <Card x={304} y={208} w={212} h={90} step={2} title="Tag pass" lines={TAG_LINES} foot="3.4 photos/s" />

      <Panel x={600} y={40} w={220} h={350} label="Models" sub="Local GPU or a remote URL" model />
      <Card
        x={614}
        y={88}
        w={192}
        h={146}
        icon="cpu"
        model
        title="EmbeddingGemma 2"
        lines={['Text and images in one', '768-d vector space', '', '• Photo embeddings', '• Label ranking', '• Query search', '• Tag suggestions']}
      />
      <Card
        x={614}
        y={246}
        w={192}
        h={130}
        icon="sparkles"
        model
        title="d1-3B"
        lines={['Yes/no questions about', 'a full-size photo', '', '• Subject tags', '• Retag all', '• Find in library']}
      />

      <Panel x={290} y={360} w={240} h={250} label="Index" sub={INDEX_DIR} />
      <Database x={304} y={410} w={212} h={128} colGap={104} />
      <Thumbs x={304} y={548} w={212} h={48} />

      <Panel x={20} y={360} w={200} h={250} label="Server" sub={SERVE} />
      <Card x={34} y={410} w={172} h={58} compact title="JSON API" lines={['Search, filters, tags,', 'likes, admin jobs']} />
      <Card x={34} y={474} w={172} h={58} compact title="Vector cache" lines={['Every vector in RAM,', 'reloads on change']} />
      <Card x={34} y={538} w={172} h={58} compact title="Static files" lines={['Web UI, thumbnails,', 'originals']} />

      <Card x={20} y={680} w={200} h={80} icon="devices" title="Web UI" lines={['React, in any browser:', 'desktop and phone on the LAN']} />

      <Arrow id={id} d="M220 133 H302" />
      <Label x={255} y={125} anchor="middle">
        New JPEGs
      </Label>
      <Arrow id={id} d="M410 178 V206" />
      <Label x={418} y={196} onPanel>
        Stored embedding
      </Label>
      <Arrow id={id} d="M410 310 V358" />
      <Label x={402} y={338} anchor="end">
        Writes rows, vectors, tags
      </Label>
      <Arrow id={id} both d="M288 485 H222" />
      <Label x={255} y={477} anchor="middle">
        Read / write
      </Label>
      <Arrow id={id} d="M120 178 V358" />
      <Label x={128} y={270}>
        Originals
      </Label>
      <Arrow id={id} both d="M100 610 V678" />
      <Label x={108} y={648}>
        HTTP
      </Label>
      <Arrow id={id} model d="M516 133 H612" />
      <Label x={565} y={125} anchor="middle">
        Image
      </Label>
      <Arrow id={id} model d="M516 253 H612" />
      <Label x={565} y={232} anchor="middle">
        Photo,
      </Label>
      <Label x={565} y={245} anchor="middle">
        questions
      </Label>
      <Arrow id={id} model d="M180 610 V642 H710 V392" />
      <Label x={445} y={634} anchor="middle">
        Query text, tagging jobs
      </Label>

      <Legend x={290} y={702} id={id} />
    </svg>
  );
}

function Narrow() {
  const id = 'sd-narrow';
  return (
    <svg viewBox="0 0 360 1392" className={styles.narrow} role="img" aria-labelledby={`${id}-t ${id}-d`}>
      <title id={`${id}-t`}>{TITLE}</title>
      <desc id={`${id}-d`}>{DESC}</desc>
      <Markers id={id} />

      <Card x={20} y={10} w={296} h={84} icon="folder" title="Photo folder" lines={['JPEG originals, never modified']} foot="Scanned for new files" />

      <Panel x={20} y={130} w={296} h={270} label="Indexing" sub={REFRESH} />
      <Card x={34} y={180} w={268} h={90} step={1} title="Embed pass" lines={EMBED_LINES} foot="14.5 photos/s" />
      <Card x={34} y={300} w={268} h={90} step={2} title="Tag pass" lines={TAG_LINES} foot="3.4 photos/s" />

      <Panel x={20} y={440} w={296} h={220} label="Index" sub={INDEX_DIR} />
      <Database x={34} y={490} w={268} h={110} colGap={134} />
      <Thumbs x={34} y={608} w={268} h={42} />

      <Panel x={20} y={700} w={296} h={212} label="Server" sub={SERVE} />
      <Card x={34} y={750} w={268} h={46} compact title="JSON API" lines={['Search, filters, tags, likes, admin jobs']} />
      <Card x={34} y={802} w={268} h={46} compact title="Vector cache" lines={['Every vector in RAM, reloads on change']} />
      <Card x={34} y={854} w={268} h={46} compact title="Static files" lines={['Web UI, thumbnails, originals']} />

      <Card x={20} y={952} w={296} h={80} icon="devices" title="Web UI" lines={['React, in any browser:', 'desktop and phone on the LAN']} />

      {/* d1-3B comes first here so the two model lanes on the right nest instead of crossing. */}
      <Panel x={20} y={1072} w={296} h={244} label="Models" sub="Local GPU or a remote URL" model />
      <Card
        x={34}
        y={1122}
        w={268}
        h={84}
        icon="sparkles"
        model
        title="d1-3B"
        lines={['Yes/no questions about a full-size photo', ['• Subject tags', '• Retag all'], ['• Find in library', '']]}
      />
      <Card
        x={34}
        y={1218}
        w={268}
        h={84}
        icon="cpu"
        model
        title="EmbeddingGemma 2"
        lines={['Text and images in one 768-d vector space', ['• Photo embeddings', '• Label ranking'], ['• Query search', '• Tag suggestions']]}
      />

      <Arrow id={id} d="M168 94 V128" />
      <Label x={176} y={115}>
        New JPEGs
      </Label>
      <Arrow id={id} d="M168 270 V298" />
      <Label x={176} y={288} onPanel>
        Stored embedding
      </Label>
      <Arrow id={id} d="M168 400 V438" />
      <Label x={176} y={423}>
        Writes rows, vectors, tags
      </Label>
      <Arrow id={id} both d="M168 662 V698" />
      <Label x={176} y={684}>
        Read / write
      </Label>
      <Arrow id={id} both d="M168 914 V950" />
      <Label x={176} y={936}>
        HTTP
      </Label>
      <Arrow id={id} d="M20 52 H10 V806 H18" />
      <Label x={14} y={300} anchor="middle" rotate>
        Originals
      </Label>
      <Arrow id={id} model d="M20 880 H10 V1100 H18" />
      <Label x={14} y={990} anchor="middle" rotate>
        Query text, jobs
      </Label>
      <Arrow id={id} model d="M302 225 H346 V1260 H304" />
      <Label x={350} y={640} anchor="middle" rotate>
        Image
      </Label>
      <Arrow id={id} model d="M302 345 H330 V1164 H304" />
      <Label x={334} y={760} anchor="middle" rotate>
        Photo, questions
      </Label>

      <Legend x={20} y={1348} id={id} />
    </svg>
  );
}

/** The system diagram for the "System overview" page. */
export default function SystemDiagram(): ReactNode {
  return (
    <figure className={styles.figure}>
      <Wide />
      <Narrow />
      <figcaption className={styles.caption}>
        Indexing writes the index; the server reads it. Rates measured on an RTX 4080.
      </figcaption>
    </figure>
  );
}
