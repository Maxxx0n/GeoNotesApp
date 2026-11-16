import { useMemo, useRef, useState } from 'react';
import { Modal, PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import {
  BlendMode,
  BlurStyle,
  Canvas,
  ImageFormat,
  PaintStyle,
  Picture,
  Skia,
  StrokeCap,
  StrokeJoin,
  createPicture,
  type SkCanvas,
  type SkPath,
} from '@shopify/react-native-skia';

type Ink = { key: string; color: string; neon?: boolean };
type Stroke = { path: SkPath; width: number; ink: Ink | null }; // ink null → eraser

// Pixel aspect is kept; size in meters is the caller's choice. Longest side in the PNG is
// capped so a full-screen sketch doesn't become a huge texture.
export type DrawingResult = { base64: string; aspect: number };

const INKS: Ink[] = [
  { key: 'black', color: '#000000' },
  { key: 'white', color: '#FFFFFF' },
  { key: 'red', color: '#FF3B30' },
  { key: 'blue', color: '#007AFF' },
  { key: 'green', color: '#34C759' },
  { key: 'yellow', color: '#FFCC00' },
  { key: 'neon', color: '#00F0FF', neon: true },
];
const NEON_CORE = '#E6FFFF';
const MIN_WIDTH = 1;
const MAX_WIDTH = 30;
const DEFAULT_WIDTH = 5;
const MAX_EXPORT_PX = 1024;

// Neon: a wide blurred halo in the ink color under a thin, nearly white core.
const neonGlowWidth = (w: number) => w * 2;
const neonBlurSigma = (w: number) => w + 4;
const strokeExtent = ({ width, ink }: Stroke) =>
  ink?.neon ? neonGlowWidth(width) / 2 + neonBlurSigma(width) * 3 : width / 2;

// Shared by the on-screen canvas and the PNG export so both look identical. Strokes go into
// their own layer so the eraser (BlendMode.Clear) cuts to transparency.
function drawStrokes(canvas: SkCanvas, strokes: Stroke[]) {
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeCap(StrokeCap.Round);
  paint.setStrokeJoin(StrokeJoin.Round);
  canvas.saveLayer();
  for (const { path, width, ink } of strokes) {
    paint.setBlendMode(ink ? BlendMode.SrcOver : BlendMode.Clear);
    paint.setMaskFilter(null);
    if (ink?.neon) {
      paint.setColor(Skia.Color(ink.color));
      paint.setStrokeWidth(neonGlowWidth(width));
      paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, neonBlurSigma(width), true));
      canvas.drawPath(path, paint);
      paint.setMaskFilter(null);
      paint.setColor(Skia.Color(NEON_CORE));
      paint.setStrokeWidth(Math.max(1, width * 0.6));
    } else {
      paint.setColor(Skia.Color(ink?.color ?? 'black'));
      paint.setStrokeWidth(width);
    }
    canvas.drawPath(path, paint);
  }
  canvas.restore();
}

// Render strokes cropped to their (non-eraser) bounds onto a transparent surface → PNG.
function exportStrokes(strokes: Stroke[]): DrawingResult | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    if (!stroke.ink) continue;
    const b = stroke.path.computeTightBounds();
    const pad = strokeExtent(stroke) + 2;
    minX = Math.min(minX, b.x - pad);
    minY = Math.min(minY, b.y - pad);
    maxX = Math.max(maxX, b.x + b.width + pad);
    maxY = Math.max(maxY, b.y + b.height + pad);
  }
  if (minX === Infinity) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  const s = Math.min(PixelRatio.get(), MAX_EXPORT_PX / Math.max(w, h));
  const surface = Skia.Surface.Make(Math.ceil(w * s), Math.ceil(h * s));
  if (!surface) return null;

  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('transparent'));
  canvas.scale(s, s);
  canvas.translate(-minX, -minY);
  drawStrokes(canvas, strokes);
  surface.flush();
  return { base64: surface.makeImageSnapshot().encodeToBase64(ImageFormat.PNG), aspect: w / h };
}

type Props = {
  visible: boolean;
  onCancel: () => void;
  onSave: (result: DrawingResult) => void;
};

export default function DrawingCanvas({ visible, onCancel, onSave }: Props) {
  const insets = useSafeAreaInsets();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  // The stroke being drawn is mutated in place; `current` holds a copy so the picture updates.
  const active = useRef<Stroke | null>(null);
  const [current, setCurrent] = useState<Stroke | null>(null);
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_WIDTH);
  const [ink, setInk] = useState<Ink>(INKS[0]);
  const [erasing, setErasing] = useState(false);

  const picture = useMemo(
    () => createPicture((canvas) => drawStrokes(canvas, current ? [...strokes, current] : strokes)),
    [strokes, current],
  );
  const hasInk = strokes.some((s) => s.ink);

  const reset = () => {
    setStrokes([]);
    setCurrent(null);
    active.current = null;
  };

  const handleStart = (e: GestureResponderEvent) => {
    const { locationX: x, locationY: y } = e.nativeEvent;
    const path = Skia.Path.Make();
    path.moveTo(x, y);
    path.lineTo(x, y); // a tap alone leaves a dot (round cap)
    const stroke = { path, width: strokeWidth, ink: erasing ? null : ink };
    active.current = stroke;
    setCurrent({ ...stroke, path: path.copy() });
  };

  const handleMove = (e: GestureResponderEvent) => {
    const stroke = active.current;
    if (!stroke) return;
    stroke.path.lineTo(e.nativeEvent.locationX, e.nativeEvent.locationY);
    setCurrent({ ...stroke, path: stroke.path.copy() });
  };

  const handleEnd = () => {
    const stroke = active.current;
    active.current = null;
    setCurrent(null);
    if (stroke) setStrokes((prev) => [...prev, stroke]);
  };

  const close = (after: () => void) => {
    reset();
    after();
  };

  const save = () => {
    const result = exportStrokes(strokes);
    if (result) close(() => onSave(result));
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => close(onCancel)}>
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.toolbar}>
          <Pressable onPress={() => close(onCancel)} style={styles.toolButton}>
            <Text style={styles.toolText}>Cancel</Text>
          </Pressable>
          <View style={styles.toolGroup}>
            <Pressable
              onPress={() => setStrokes((prev) => prev.slice(0, -1))}
              disabled={!strokes.length}
              style={styles.toolButton}
            >
              <Text style={[styles.toolText, !strokes.length && styles.disabled]}>Undo</Text>
            </Pressable>
            <Pressable onPress={reset} disabled={!strokes.length} style={styles.toolButton}>
              <Text style={[styles.toolText, !strokes.length && styles.disabled]}>Clear</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={save}
            disabled={!hasInk}
            style={[styles.saveButton, !hasInk && styles.disabled]}
          >
            <Text style={styles.saveText}>Save</Text>
          </Pressable>
        </View>

        <View style={styles.palette}>
          {INKS.map((option) => {
            const selected = !erasing && option.key === ink.key;
            return (
              <Pressable
                key={option.key}
                accessibilityLabel={`${option.key} ink`}
                onPress={() => {
                  setInk(option);
                  setErasing(false);
                }}
                style={[styles.swatchRing, selected && styles.swatchRingSelected]}
              >
                <View
                  style={[
                    styles.swatch,
                    { backgroundColor: option.color },
                    option.neon && { shadowColor: option.color, ...styles.swatchNeon },
                  ]}
                />
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => setErasing((on) => !on)}
            style={[styles.eraserButton, erasing && styles.eraserButtonActive]}
          >
            <Text style={[styles.eraserText, erasing && styles.eraserTextActive]}>Eraser</Text>
          </Pressable>
        </View>

        <View
          style={styles.paper}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={handleStart}
          onResponderMove={handleMove}
          onResponderRelease={handleEnd}
          onResponderTerminate={handleEnd}
        >
          {/* pointerEvents none: touches must target the View so locationX/Y are relative to it */}
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            <Picture picture={picture} />
          </Canvas>
        </View>

        <View style={styles.widthRow}>
          <Text style={styles.widthLabel}>{strokeWidth} px</Text>
          <Slider
            style={styles.widthSlider}
            value={strokeWidth}
            minimumValue={MIN_WIDTH}
            maximumValue={MAX_WIDTH}
            step={1}
            minimumTrackTintColor={ACCENT}
            onValueChange={setStrokeWidth}
          />
          <View style={[styles.widthPreviewBox, { backgroundColor: PAPER }]}>
            <View
              style={{
                width: strokeWidth,
                height: strokeWidth,
                borderRadius: strokeWidth / 2,
                backgroundColor: erasing ? 'transparent' : ink.color,
                borderWidth: erasing ? 1 : 0,
                borderColor: '#fff',
              }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const ACCENT = '#FFD633';
// Mid gray so both black and white ink show. Display only — the exported PNG is transparent,
// and erased areas show this through.
const PAPER = '#8E8E93';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1c1c1e',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  toolGroup: {
    flexDirection: 'row',
  },
  toolButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  toolText: {
    color: '#fff',
    fontSize: 16,
  },
  disabled: {
    opacity: 0.4,
  },
  saveButton: {
    backgroundColor: ACCENT,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 10,
  },
  saveText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
  },
  palette: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 6,
  },
  swatchRing: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchRingSelected: {
    borderColor: ACCENT,
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  swatchNeon: {
    shadowOpacity: 1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  eraserButton: {
    marginLeft: 'auto',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  eraserButtonActive: {
    backgroundColor: ACCENT,
    borderColor: ACCENT,
  },
  eraserText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  eraserTextActive: {
    color: '#000',
  },
  paper: {
    flex: 1,
    backgroundColor: PAPER,
    marginHorizontal: 8,
    borderRadius: 12,
    overflow: 'hidden',
  },
  widthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  widthLabel: {
    color: '#fff',
    fontSize: 14,
    width: 44,
  },
  widthSlider: {
    flex: 1,
  },
  widthPreviewBox: {
    width: MAX_WIDTH + 8,
    height: MAX_WIDTH + 8,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
