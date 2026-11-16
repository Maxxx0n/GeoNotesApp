import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import ExpoAr, {
  ExpoArView,
  getCapabilities,
  type Anchor,
  type AnchorsEvent,
  type ArViewHandle,
  type MappingStatusEvent,
  type PlanesEvent,
  type ProjectedPoint,
  type ProjectionEvent,
  type TapEvent,
  type TrackingState,
  type TrackingStateEvent,
  type Transform,
  type WorldMappingStatus,
} from '@stewmore/expo-ar';
import DrawingCanvas, { type DrawingResult } from '../components/DrawingCanvas';
import { applyOffset, basisFromCamera, type EditBasis, type Offset } from '../lib/anchorOffset';
import { loadSettings, saveSettings } from '../lib/settings';
import {
  clearImages,
  imageUri,
  pruneImages,
  saveDrawingPng,
  savePhoto,
  type ImageKind,
} from '../lib/imageStore';
import { extractUrl, extractYandexMusicUrl, yandexMusicAppUrl } from '../lib/noteLinks';
import {
  isVerticalNormal,
  surfaceImagePose,
  surfaceUp,
  type DrawingAngles,
  type Vec3,
} from '../lib/wallOrientation';

type TextNote = { kind?: 'text'; anchorId: string; text: string };
// Drawings and photos: an image lying on the anchor's surface, shown in 3D.
type ImageNote = {
  kind: ImageKind;
  anchorId: string;
  file: string; // name in Documents/<kind>s/ (see imageStore)
  width: number; // meters
  height: number;
  normal: Vec3; // outward surface normal at the anchor
  up: Vec3; // image's top edge on the surface, before angles (see surfaceUp)
} & DrawingAngles; // user adjustments, degrees (see surfaceImagePose)
// Drawing notes saved before pitch/yaw/up existed had a single `tilt` (about the wall's
// vertical, i.e. today's yaw).
type LegacyDrawingNote = Omit<ImageNote, 'up' | 'pitch' | 'yaw'> &
  Partial<Pick<ImageNote, 'up' | 'pitch' | 'yaw'>> & { tilt?: number };
// Music (Yandex Music) and plain links: a tappable icon at the anchor that opens the URL.
type LinkNote = { kind: 'music' | 'link'; anchorId: string; url: string };
type Note = TextNote | ImageNote | LinkNote;
// What the note-input modal is collecting.
type InputKind = 'text' | 'music' | 'link';
// planes: outward surface normal per anchor id, captured at placement.
type SavedMetadata = { notes: Note[]; planes?: Record<string, Vec3> };
type EditState = { id: string; base: Transform; basis: EditBasis };
type EditTab = 'position' | 'rotate';

// Metadata saved alongside the world map. null → no saved map, start fresh.
function loadSavedMetadata(): SavedMetadata | null {
  const raw = ExpoAr.getSavedWorldMapMetadata();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedMetadata;
    return {
      notes: (parsed.notes ?? []).map(migrateNote),
      planes: parsed.planes ?? {},
    };
  } catch {
    return { notes: [], planes: {} };
  }
}

function migrateNote(note: Note | LegacyDrawingNote): Note {
  if (note.kind !== 'drawing') return note as Note; // only drawings predate up/pitch/yaw
  const { tilt, ...rest } = note as LegacyDrawingNote;
  return {
    ...rest,
    up: rest.up ?? surfaceUp(rest.normal),
    pitch: rest.pitch ?? 0,
    yaw: rest.yaw ?? tilt ?? 0,
  };
}

const isImageNote = (n: Note | undefined): n is ImageNote =>
  n?.kind === 'drawing' || n?.kind === 'photo';

const isLinkNote = (n: Note | undefined): n is LinkNote =>
  n?.kind === 'music' || n?.kind === 'link';

const imageFiles = (notes: Note[]): Record<ImageKind, Set<string>> => {
  const files = { drawing: new Set<string>(), photo: new Set<string>() };
  for (const n of notes) if (isImageNote(n)) files[n.kind].add(n.file);
  return files;
};

// Images lie on their surface (wall, floor, slope), adjusted by the user's angles.
const imagePose = (n: ImageNote) => surfaceImagePose(n.normal, n.up, n);

const INPUT_UI: Record<InputKind, { title: string; placeholder: string }> = {
  text: { title: 'Note', placeholder: "What's here?" },
  music: { title: 'Yandex Music', placeholder: 'Paste a music.yandex.ru link' },
  link: { title: 'Link', placeholder: 'Paste a URL' },
};
const LINK_ICONS: Record<LinkNote['kind'], string> = { music: '▶', link: '🔗' };

// If ARKit never reports a plane (e.g. plain floor), still allow placement after this
// long in normal tracking — the estimated-plane raycast fallback may find a hit.
const NO_PLANE_FALLBACK_MS = 5000;
const TOAST_MS = 2000;
// How close (in points) a tap must land to a marker's projected center to select it.
const MARKER_HIT_RADIUS = 36;
// Slider range for anchor correction, in meters either way.
const MAX_OFFSET_M = 3;
const ZERO_OFFSET: Offset = { x: 0, y: 0, z: 0 };
// Longest side of a drawing or photo in the world.
const IMAGE_SIZE_M = 0.3;
// ARKit world-mapping quality. Below `extending`, raycast depth is unreliable, so markers
// placed then are flagged with a warning color until the user corrects them.
const MAPPING_UI: Record<WorldMappingStatus, { label: string; color: string; progress: number }> = {
  notAvailable: { label: 'Scanning…', color: '#FF3B30', progress: 0.25 },
  limited: { label: 'Limited', color: '#FF9500', progress: 0.5 },
  extending: { label: 'Good', color: '#FFD633', progress: 0.75 },
  mapped: { label: 'Ready', color: '#34C759', progress: 1 },
};
const isRoughMapping = (s: WorldMappingStatus) => s === 'notAvailable' || s === 'limited';

const DRAWING_ANGLE_SLIDERS = [
  ['rotation', 'Roll', 180],
  ['pitch', 'Pitch', 90],
  ['yaw', 'Yaw', 180],
] as const;

export default function ARView() {
  const insets = useSafeAreaInsets();
  const arViewRef = useRef<ArViewHandle>(null);
  const [capabilities] = useState(() => getCapabilities());
  // LiDAR → scene-mesh reconstruction, which the native view uses for real occlusion.
  const lidar = capabilities.depthOrLidarAvailable;
  // Ghost mode: without LiDAR, dim anchors that are behind a detected wall.
  const [ghostMode, setGhostMode] = useState(() => loadSettings().ghostMode);
  // Read once on launch; the native view has already loaded the matching world map.
  const [saved] = useState(loadSavedMetadata);
  const [restorePending, setRestorePending] = useState(saved !== null);
  const attachedIds = useRef(new Set<string>());
  const [tracking, setTracking] = useState<TrackingState>('initializing');
  const [planeCount, setPlaneCount] = useState(0);
  const [mapping, setMapping] = useState<WorldMappingStatus>('notAvailable');
  // Anchors placed while mapping was rough (shown orange). Session-only; cleared once the
  // user corrects the anchor's position. A ref so sphere attachment sees it immediately.
  const roughIds = useRef(new Set<string>());
  const [noPlaneFallback, setNoPlaneFallback] = useState(false);
  // Native anchor list incl. current transforms — the source of truth for (corrected)
  // positions, which Save World Map persists.
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [notes, setNotes] = useState<Note[]>(saved?.notes ?? []);
  const [planes, setPlanes] = useState<Record<string, Vec3>>(saved?.planes ?? {});
  const [drawingVisible, setDrawingVisible] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projections, setProjections] = useState<Record<string, ProjectedPoint>>({});
  const [modalVisible, setModalVisible] = useState(false);
  const [draft, setDraft] = useState('');
  const [inputKind, setInputKind] = useState<InputKind>('text');
  const [inputError, setInputError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [offset, setOffset] = useState<Offset>(ZERO_OFFSET);
  const [editTab, setEditTab] = useState<EditTab>('position');
  // Anchor whose long-press menu (Edit / Delete) is open.
  const [menuId, setMenuId] = useState<string | null>(null);

  // The plane fallback is armed by this timer and disarmed in handleTrackingChange.
  useEffect(() => {
    if (tracking !== 'normal') return;
    const timer = setTimeout(() => setNoPlaneFallback(true), NO_PLANE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [tracking]);

  // Images from a session that was never saved are orphans.
  useEffect(() => {
    try {
      pruneImages(imageFiles(saved?.notes ?? []));
    } catch (e) {
      console.log('Could not prune images', e);
    }
  }, [saved]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const noteFor = (id: string) => notes.find((n) => n.anchorId === id);
  const editingNote = editing ? noteFor(editing.id) : undefined;
  const editingImage = isImageNote(editingNote) ? editingNote : null;

  // Position sliders → native anchor transform. ZERO_OFFSET (by identity) is the untouched
  // state set when editing starts; skipping it avoids needlessly replacing the anchor.
  useEffect(() => {
    if (!editing || offset === ZERO_OFFSET) return;
    arViewRef.current?.setAnchorTransform?.(
      editing.id,
      applyOffset(editing.base, editing.basis, offset),
    );
  }, [editing, offset]);

  // Roll/Pitch/Yaw sliders → native pose of the image being edited.
  useEffect(() => {
    if (editingImage) {
      arViewRef.current?.setModelPose?.(editingImage.anchorId, imagePose(editingImage));
    }
  }, [editingImage]);

  if (!capabilities.arSupported) {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>This device does not support ARKit.</Text>
      </View>
    );
  }

  const canPlace = tracking === 'normal' && (planeCount > 0 || noPlaneFallback);

  const markerAt = (x: number, y: number) => {
    let best: { id: string; dist: number } | null = null;
    for (const p of Object.values(projections)) {
      if (!p.inFront) continue;
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist <= MARKER_HIT_RADIUS && (!best || dist < best.dist)) best = { id: p.id, dist };
    }
    return best?.id ?? null;
  };

  // The anchor's 3D visual: its drawing/photo if it has one, else the marker sphere.
  const showAnchor = async (id: string, note: Note | undefined, highlighted = false) => {
    const ar = arViewRef.current;
    if (isImageNote(note)) {
      const shown = await ar?.attachImage?.(
        id,
        imageUri(note.kind, note.file),
        note.width,
        note.height,
        imagePose(note),
        highlighted,
      );
      if (shown) return;
    }
    const sphere = highlighted
      ? 'builtin:sphere-highlight'
      : roughIds.current.has(id)
        ? 'builtin:sphere-warning'
        : 'builtin:sphere';
    await ar?.attachModel?.(id, sphere);
  };

  const startEditing = async (id: string) => {
    const anchor = anchors.find((a) => a.id === id);
    const camera = await arViewRef.current?.getCameraTransform?.();
    if (!anchor || !camera) return;
    await showAnchor(id, noteFor(id), true);
    setSelectedId(id);
    setOffset(ZERO_OFFSET);
    setEditTab('position');
    setEditing({ id, base: anchor.transform, basis: basisFromCamera(camera) });
  };

  const updateOffset = (axis: keyof Offset, value: number) => {
    setOffset((prev) => ({ ...prev, [axis]: value }));
  };

  const updateImageAngle = (field: keyof DrawingAngles, value: number) => {
    if (!editingImage) return;
    const next = { ...editingImage, [field]: value };
    setNotes((prev) => prev.map((n) => (n.anchorId === next.anchorId ? next : n)));
  };

  // The anchor already sits at its corrected transform natively, and onAnchorsChange has
  // mirrored it into `anchors` state — Done just leaves edit mode.
  const finishEditing = async () => {
    if (!editing) return;
    if (offset !== ZERO_OFFSET) roughIds.current.delete(editing.id); // user corrected it
    await showAnchor(editing.id, noteFor(editing.id));
    setEditing(null);
  };

  // Removed from the session and local state now; persisted only by the next Save World Map
  // (until then, relaunching restores the last saved map with the anchor).
  const deleteAnchor = async (id: string) => {
    setMenuId(null);
    await arViewRef.current?.detachModel?.(id);
    await arViewRef.current?.removeAnchor(id);
    attachedIds.current.delete(id);
    roughIds.current.delete(id);
    setNotes((prev) => prev.filter((n) => n.anchorId !== id));
    setPlanes(({ [id]: _removed, ...rest }) => rest);
    setProjections(({ [id]: _removed, ...rest }) => rest);
    setToast('Anchor deleted');
  };

  // Native guarantees a press is either onTap or onLongPress, never both.
  const handleLongPress = ({ nativeEvent }: { nativeEvent: TapEvent }) => {
    if (editing) return;
    const hitId = markerAt(nativeEvent.x, nativeEvent.y);
    if (hitId) setMenuId(hitId);
  };

  const handleTap = async ({ nativeEvent }: { nativeEvent: TapEvent }) => {
    if (editing) return;
    if (menuId) {
      setMenuId(null); // tapping anywhere else dismisses the menu
      return;
    }
    const hitId = markerAt(nativeEvent.x, nativeEvent.y);
    if (hitId) {
      await startEditing(hitId);
      return;
    }
    if (!canPlace) {
      setToast('Still scanning — keep moving the phone');
      return;
    }
    const anchor = await arViewRef.current?.addAnchor(nativeEvent.x, nativeEvent.y);
    if (!anchor) {
      setToast('No surface there — aim at a highlighted area');
      return;
    }
    if (anchor.normal) {
      const [x, y, z] = anchor.normal;
      setPlanes((prev) => ({ ...prev, [anchor.id]: { x, y, z } }));
      if (isVerticalNormal({ x, y, z })) setToast('Marker placed on wall');
    }
    if (isRoughMapping(mapping)) {
      // onAnchorsChange may already have attached the normal sphere — re-attach as warning.
      roughIds.current.add(anchor.id);
      showAnchor(anchor.id, undefined);
      setToast('Move the phone around to scan the space');
    }
    setSelectedId(anchor.id);
  };

  const handleAnchorsChange = ({ nativeEvent }: { nativeEvent: AnchorsEvent }) => {
    const ids = nativeEvent.anchors.map((a) => a.id);
    setAnchors(nativeEvent.anchors);
    // Covers both freshly placed anchors and ones restored from the saved world map.
    // Notes aren't pruned here: restored anchors can arrive after a newly placed one.
    for (const id of ids) {
      if (!attachedIds.current.has(id)) {
        attachedIds.current.add(id);
        showAnchor(id, noteFor(id));
      }
    }
    setSelectedId((prev) => (prev && ids.includes(prev) ? prev : null));
  };

  const handleTrackingChange = ({ nativeEvent }: { nativeEvent: TrackingStateEvent }) => {
    setTracking(nativeEvent.state);
    if (nativeEvent.state === 'normal') {
      // Native drops the world map once tracking is normal, i.e. relocalization finished.
      setRestorePending(false);
    } else {
      setNoPlaneFallback(false);
    }
  };

  const handleProjection = ({ nativeEvent }: { nativeEvent: ProjectionEvent }) => {
    setProjections(Object.fromEntries(nativeEvent.points.map((p) => [p.id, p])));
  };

  const openEditor = (anchorId: string | null, kind: InputKind = 'text') => {
    if (!anchorId) {
      setToast('Tap a surface to place a marker first');
      return;
    }
    setSelectedId(anchorId);
    const note = noteFor(anchorId);
    // Prefill when editing a note of the same kind.
    let prefill = '';
    if (note && !isImageNote(note) && (note.kind ?? 'text') === kind) {
      prefill = isLinkNote(note) ? note.url : note.text;
    }
    setDraft(prefill);
    setInputKind(kind);
    setInputError(null);
    setModalVisible(true);
  };

  // Music goes straight to the Yandex Music app (yandexmusic://…); openURL rejects when the
  // app isn't installed, and then the web link opens in the browser instead.
  const openLinkNote = async ({ kind, url }: LinkNote) => {
    const appUrl = kind === 'music' ? yandexMusicAppUrl(url) : null;
    try {
      await Linking.openURL(appUrl ?? url);
    } catch {
      if (!appUrl) {
        setToast('Could not open the link');
        return;
      }
      Linking.openURL(url).catch(() => setToast('Could not open the link'));
    }
  };

  const chooseNoteType = () => {
    if (!selectedId) {
      setToast('Tap a surface to place a marker first');
      return;
    }
    Alert.alert('Add note', undefined, [
      { text: 'Text', onPress: () => openEditor(selectedId) },
      { text: 'Draw', onPress: () => setDrawingVisible(true) },
      { text: 'Photo', onPress: pickPhoto },
      { text: 'Music', onPress: () => openEditor(selectedId, 'music') },
      { text: 'Link', onPress: () => openEditor(selectedId, 'link') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const parseInput = (): Note | string => {
    const id = selectedId!;
    if (inputKind === 'text') return { anchorId: id, text: draft.trim() };
    const url = inputKind === 'music' ? extractYandexMusicUrl(draft) : extractUrl(draft);
    if (!url) {
      return inputKind === 'music'
        ? 'That isn’t a Yandex Music link (music.yandex.ru/…)'
        : 'No link found in that text';
    }
    return { kind: inputKind, anchorId: id, url };
  };

  const saveNote = () => {
    if (!selectedId || !draft.trim()) return;
    const note = parseInput();
    if (typeof note === 'string') {
      setInputError(note);
      return;
    }
    // Replacing an image with a text/link note → back to the marker sphere.
    if (isImageNote(noteFor(selectedId))) showAnchor(selectedId, undefined);
    setNotes((prev) => [...prev.filter((n) => n.anchorId !== selectedId), note]);
    setModalVisible(false);
  };

  // Outward normal of the anchor's surface. Anchors placed before normals were recorded
  // fall back to the anchor's Y axis (the raycast surface normal), flipped toward the camera.
  const anchorNormal = (id: string, camera: Transform | null): Vec3 | null => {
    if (planes[id]) return planes[id];
    const t = anchors.find((a) => a.id === id)?.transform;
    if (!t) return null;
    const n = { x: t[4], y: t[5], z: t[6] };
    if (!camera) return n;
    const facing =
      n.x * (camera[12] - t[12]) + n.y * (camera[13] - t[13]) + n.z * (camera[14] - t[14]);
    return facing < 0 ? { x: -n.x, y: -n.y, z: -n.z } : n;
  };

  // Pin an image (written to Documents by `save`, which returns its file name) on the
  // selected anchor's surface. `aspect` is width / height.
  const pinImage = async (kind: ImageKind, save: () => string, aspect: number) => {
    const id = selectedId;
    const camera = (await arViewRef.current?.getCameraTransform?.()) ?? null;
    const normal = id ? anchorNormal(id, camera) : null;
    if (!id || !normal) return;
    // On flat surfaces the image's top points away from the user (camera looks down -Z).
    const cameraForward = camera ? { x: -camera[8], y: -camera[9], z: -camera[10] } : undefined;
    let file: string;
    try {
      file = save();
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Could not save ${kind}`);
      return;
    }
    const note: ImageNote = {
      kind,
      anchorId: id,
      file,
      width: aspect >= 1 ? IMAGE_SIZE_M : IMAGE_SIZE_M * aspect,
      height: aspect >= 1 ? IMAGE_SIZE_M / aspect : IMAGE_SIZE_M,
      normal,
      up: surfaceUp(normal, cameraForward),
      rotation: 0,
      pitch: 0,
      yaw: 0,
    };
    setNotes((prev) => [...prev.filter((n) => n.anchorId !== id), note]);
    await showAnchor(id, note);
  };

  const saveDrawing = ({ base64, aspect }: DrawingResult) => {
    setDrawingVisible(false);
    pinImage('drawing', () => saveDrawingPng(base64), aspect);
  };

  // iOS's photo picker runs out of process, so no library permission is requested.
  const pickPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      quality: 0.8,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    // width/height can be 0 when the system doesn't report them; fall back to square.
    const aspect = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1;
    await pinImage('photo', () => savePhoto(asset.uri), aspect);
  };

  const toggleGhostMode = () => {
    const next = !ghostMode;
    setGhostMode(next);
    saveSettings({ ghostMode: next });
  };

  const saveWorldMap = async () => {
    try {
      const anchorIds = new Set(anchors.map((a) => a.id));
      const metadata: SavedMetadata = {
        notes,
        planes: Object.fromEntries(Object.entries(planes).filter(([id]) => anchorIds.has(id))),
      };
      const count = await arViewRef.current?.saveWorldMap?.(JSON.stringify(metadata));
      // The saved metadata is now the source of truth; drop images it no longer references.
      pruneImages(imageFiles(notes));
      setToast(`Saved ${count ?? 0} marker${count === 1 ? '' : 's'}`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not save world map');
    }
  };

  const resetAll = () => {
    Alert.alert('Reset?', 'This deletes the saved world map and all notes.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          ExpoAr.clearSavedWorldMap();
          clearImages();
          await arViewRef.current?.reset();
          attachedIds.current.clear();
          roughIds.current.clear();
          setNotes([]);
          setPlanes({});
          setSelectedId(null);
          setEditing(null);
          setMenuId(null);
          setProjections({});
          setRestorePending(false);
        },
      },
    ]);
  };

  const hint = restorePending
    ? 'Point at the area where you saved to restore your notes'
    : 'Move the phone around to detect surfaces';

  return (
    <View style={styles.container}>
      <ExpoArView
        ref={arViewRef}
        style={StyleSheet.absoluteFill}
        planeDetection="both"
        depthEnabled={lidar}
        occlusionHints={ghostMode && !lidar}
        showPlanes
        emitProjections
        onTap={handleTap}
        onLongPress={handleLongPress}
        onAnchorsChange={handleAnchorsChange}
        onMappingStatusChange={({ nativeEvent }: { nativeEvent: MappingStatusEvent }) =>
          setMapping(nativeEvent.status)
        }
        onPlanesChange={({ nativeEvent }: { nativeEvent: PlanesEvent }) =>
          setPlaneCount(nativeEvent.count)
        }
        onProjection={handleProjection}
        onTrackingStateChange={handleTrackingChange}
        onError={({ nativeEvent }) => {
          // no_hit is surfaced as a toast from handleTap.
          if (nativeEvent.code !== 'no_hit') {
            console.log('AR error', nativeEvent.code, nativeEvent.message);
          }
        }}
      />

      {notes.map((note) => {
        if (isImageNote(note)) return null; // drawn in 3D
        const point = projections[note.anchorId];
        if (!point?.inFront) return null;
        if (isLinkNote(note)) {
          return (
            <Pressable
              key={note.anchorId}
              accessibilityRole="link"
              accessibilityLabel={note.kind === 'music' ? 'Play on Yandex Music' : 'Open link'}
              onPress={() => openLinkNote(note)}
              style={[
                styles.linkIcon,
                { left: point.x - LINK_ICON_SIZE / 2, top: point.y - 44 - LINK_ICON_SIZE / 2 },
                note.kind === 'music' && styles.musicIcon,
                note.anchorId === selectedId && styles.labelSelected,
                point.occluded && styles.labelGhost,
              ]}
            >
              <Text style={styles.linkIconText}>{LINK_ICONS[note.kind]}</Text>
            </Pressable>
          );
        }
        const { anchorId, text } = note;
        return (
          <Pressable
            key={anchorId}
            onPress={() => openEditor(anchorId)}
            style={[
              styles.labelWrap,
              { left: point.x - LABEL_WIDTH / 2, top: point.y - 44 },
              point.occluded && styles.labelGhost,
            ]}
          >
            <Text
              numberOfLines={2}
              style={[styles.label, anchorId === selectedId && styles.labelSelected]}
            >
              {point.occluded ? '⚠︎ ' : ''}
              {text}
            </Text>
          </Pressable>
        );
      })}

      {menuId && projections[menuId]?.inFront && (
        <View
          style={[
            styles.menu,
            {
              left: projections[menuId].x - MENU_WIDTH / 2,
              top: projections[menuId].y + 28,
            },
          ]}
        >
          <Pressable
            onPress={() => {
              const id = menuId;
              setMenuId(null);
              startEditing(id);
            }}
            style={styles.menuItem}
          >
            <Text style={styles.menuText}>Edit</Text>
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable onPress={() => deleteAnchor(menuId)} style={styles.menuItem}>
            <Text style={[styles.menuText, styles.resetText]}>Delete</Text>
          </Pressable>
        </View>
      )}

      <View style={[styles.hud, { top: insets.top + 8 }]} pointerEvents="none">
        <Text style={styles.hudText}>Tracking: {tracking}</Text>
        <Text style={[styles.hudText, { color: lidar ? '#34C759' : '#8E8E93' }]}>
          LiDAR: {lidar ? 'ON' : 'OFF'}
        </Text>
        <Text style={styles.hudText}>
          Planes: {planeCount} · Anchors: {anchors.length}
        </Text>
        <View style={styles.mapping}>
          <Text style={styles.mappingText}>Map: {MAPPING_UI[mapping].label}</Text>
          <View style={styles.mappingTrack}>
            <View
              style={{
                width: `${MAPPING_UI[mapping].progress * 100}%`,
                height: '100%',
                backgroundColor: MAPPING_UI[mapping].color,
              }}
            />
          </View>
        </View>
      </View>

      <View style={[styles.topActions, { top: insets.top + 8 }]}>
        <Pressable onPress={saveWorldMap} style={styles.topButton}>
          <Text style={styles.topButtonText}>Save World Map</Text>
        </Pressable>
        {/* With LiDAR, the scene mesh occludes for real — ghost mode would do nothing. */}
        {!lidar && (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: ghostMode }}
            onPress={toggleGhostMode}
            style={styles.topButton}
          >
            <Text style={[styles.topButtonText, !ghostMode && styles.topButtonOff]}>
              Ghost: {ghostMode ? 'On' : 'Off'}
            </Text>
          </Pressable>
        )}
        <Pressable onPress={resetAll} style={styles.topButton}>
          <Text style={[styles.topButtonText, styles.resetText]}>Reset</Text>
        </Pressable>
      </View>

      {(!canPlace || toast) && (
        <View style={styles.hintWrap} pointerEvents="none">
          <Text style={styles.hint}>{toast ?? hint}</Text>
        </View>
      )}

      {editing ? (
        <View style={[styles.editPanel, { paddingBottom: insets.bottom + 16 }]}>
          {/* Only drawings can be rotated; plain markers get the position sliders alone. */}
          {editingImage && (
            <View style={styles.tabs}>
              {(
                [
                  ['position', 'Position'],
                  ['rotate', 'Rotate'],
                ] as const
              ).map(([tab, label]) => (
                <Pressable
                  key={tab}
                  onPress={() => setEditTab(tab)}
                  style={[styles.tab, editTab === tab && styles.tabActive]}
                >
                  <Text style={[styles.tabText, editTab === tab && styles.tabTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {(!editingImage || editTab === 'position') &&
            (
              [
                ['x', 'Left / Right'],
                ['y', 'Down / Up'],
                ['z', 'Toward / Away'],
              ] as const
            ).map(([axis, label]) => (
              <View key={axis} style={styles.sliderRow}>
                <Text style={styles.sliderLabel}>
                  {label}: {Math.round(offset[axis] * 100)} cm
                </Text>
                <Slider
                  value={offset[axis]}
                  minimumValue={-MAX_OFFSET_M}
                  maximumValue={MAX_OFFSET_M}
                  minimumTrackTintColor={EDIT_ACCENT}
                  onValueChange={(v) => updateOffset(axis, v)}
                />
              </View>
            ))}
          {editingImage &&
            editTab === 'rotate' &&
            DRAWING_ANGLE_SLIDERS.map(([field, label, max]) => (
              <View key={field} style={styles.sliderRow}>
                <Text style={styles.sliderLabel}>
                  {label}: {Math.round(editingImage[field])}°
                </Text>
                <Slider
                  value={editingImage[field]}
                  minimumValue={-max}
                  maximumValue={max}
                  step={1}
                  minimumTrackTintColor={EDIT_ACCENT}
                  onValueChange={(v) => updateImageAngle(field, v)}
                />
              </View>
            ))}
          <Pressable onPress={finishEditing} style={styles.doneButton}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityLabel="Add note to selected marker"
          onPress={chooseNoteType}
          style={({ pressed }) => [
            styles.addButton,
            { bottom: insets.bottom + 24 },
            !selectedId && styles.addButtonDisabled,
            pressed && styles.addButtonPressed,
          ]}
        >
          <Text style={styles.addButtonText}>+</Text>
        </Pressable>
      )}

      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.modalTitle}>{INPUT_UI[inputKind].title}</Text>
            <TextInput
              value={draft}
              onChangeText={(value) => {
                setDraft(value);
                setInputError(null);
              }}
              placeholder={INPUT_UI[inputKind].placeholder}
              placeholderTextColor="#888"
              style={styles.input}
              autoFocus
              multiline={inputKind === 'text'}
              {...(inputKind !== 'text' && {
                keyboardType: 'url',
                autoCapitalize: 'none',
                autoCorrect: false,
              })}
            />
            {inputError && <Text style={styles.inputError}>{inputError}</Text>}
            <View style={styles.modalActions}>
              <Pressable onPress={() => setModalVisible(false)} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={saveNote}
                disabled={!draft.trim()}
                style={[styles.primaryButton, !draft.trim() && styles.addButtonDisabled]}
              >
                <Text style={styles.primaryButtonText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <DrawingCanvas
        visible={drawingVisible}
        onCancel={() => setDrawingVisible(false)}
        onSave={saveDrawing}
      />
    </View>
  );
}

const LABEL_WIDTH = 160;
const LINK_ICON_SIZE = 40;
const MENU_WIDTH = 140;
const ACCENT = '#FFD633';
const EDIT_ACCENT = '#33E6FF';

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    textAlign: 'center',
    fontSize: 16,
    color: '#fff',
  },
  hud: {
    position: 'absolute',
    left: 16,
    right: 16,
  },
  mapping: {
    alignSelf: 'flex-start',
    width: 140,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  mappingText: {
    color: '#fff',
    fontSize: 14,
    marginBottom: 4,
  },
  mappingTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  hudText: {
    color: '#fff',
    fontSize: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 4,
    alignSelf: 'flex-start',
  },
  topButtonOff: {
    color: '#8E8E93',
  },
  labelGhost: {
    opacity: 0.5,
  },
  topActions: {
    position: 'absolute',
    right: 16,
    alignItems: 'flex-end',
    gap: 6,
  },
  topButton: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  topButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  resetText: {
    color: '#FF6B6B',
  },
  hintWrap: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  hint: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    overflow: 'hidden',
  },
  linkIcon: {
    position: 'absolute',
    width: LINK_ICON_SIZE,
    height: LINK_ICON_SIZE,
    borderRadius: LINK_ICON_SIZE / 2,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  musicIcon: {
    backgroundColor: '#FC3F1D', // Yandex red
  },
  linkIconText: {
    color: '#fff',
    fontSize: 18,
  },
  inputError: {
    color: '#FF6B6B',
    fontSize: 13,
    marginTop: 8,
  },
  labelWrap: {
    position: 'absolute',
    width: LABEL_WIDTH,
    alignItems: 'center',
  },
  label: {
    color: '#fff',
    fontSize: 14,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: 'hidden',
    textAlign: 'center',
  },
  labelSelected: {
    borderWidth: 1,
    borderColor: ACCENT,
  },
  addButton: {
    position: 'absolute',
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  addButtonDisabled: {
    opacity: 0.4,
  },
  addButtonPressed: {
    transform: [{ scale: 0.94 }],
  },
  addButtonText: {
    fontSize: 36,
    lineHeight: 40,
    color: '#000',
    fontWeight: '600',
  },
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    flexDirection: 'row',
    backgroundColor: 'rgba(28,28,30,0.95)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  menuItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  menuText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  menuDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  editPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(28,28,30,0.92)',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 9,
    padding: 2,
    marginBottom: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: 7,
  },
  tabActive: {
    backgroundColor: EDIT_ACCENT,
  },
  tabText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  tabTextActive: {
    color: '#000',
  },
  sliderRow: {
    marginBottom: 4,
  },
  sliderLabel: {
    color: '#fff',
    fontSize: 13,
  },
  doneButton: {
    alignSelf: 'flex-end',
    backgroundColor: EDIT_ACCENT,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 4,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalCard: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 12,
  },
  input: {
    minHeight: 80,
    color: '#fff',
    fontSize: 16,
    backgroundColor: '#2c2c2e',
    borderRadius: 10,
    padding: 12,
    textAlignVertical: 'top',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 12,
  },
  secondaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: '#aaa',
    fontSize: 16,
  },
  primaryButton: {
    backgroundColor: ACCENT,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
  primaryButtonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
  },
});
