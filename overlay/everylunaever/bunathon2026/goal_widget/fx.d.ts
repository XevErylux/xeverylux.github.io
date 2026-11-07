type RGB = [number, number, number];

type Mote = {
    color: RGB;
    glyph: string | null;
    twinkleSpeed: number;
    twinkle: number;
    alpha: number;
    x: number;
    y: number;
    vy: number;
    vx: number;
    size: number;
    wobble: number;
    freq: number;
    phase: number;
};

type Spark = {
    y: number;
    x: number;
    vx: number;
    vy: number;
    size: number;
    gravity: number;
    drag: number;
    maxLife: number;
    life: number;
    color: RGB;
};

type Stream = {
    color: RGB;
    size: number;
    ty: number;
    tx: number;
    cy: number;
    cx: number;
    fy: number;
    fx: number;
    t: number;
    duration: number;
    delay: number;
};

type Ring = {
    squash: number;
    y: number;
    x: number;
    width: number;
    color: RGB;
    maxRadius: number;
    t: any;
    duration: any;
};
