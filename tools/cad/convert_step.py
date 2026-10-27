"""Convierte el CAD STEP de un robot en un GLB articulable + JSON de cinemática.

Uso:
  python convert_step.py --config irb14050.json --out ../../public/robots/irb14050

El config indica el STEP del brazo, el orden de los eslabones y las piezas de la
herramienta. Los ejes de cada articulación se detectan solos: son las superficies
cilíndricas coaxiales que comparten dos eslabones consecutivos (rodamientos, ejes).
"""
import argparse, json, os, sys
import numpy as np
import trimesh
import fast_simplification

from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType
from OCP.TDF import TDF_Label, TDF_ChildIterator
from OCP.TDataStd import TDataStd_Name
from OCP.TopLoc import TopLoc_Location
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopoDS import TopoDS
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Cylinder
from OCP.Quantity import Quantity_Color
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps


# ---------------------------------------------------------------- lectura STEP

def read_step(path):
    """Devuelve {nombre_pieza: dict(V, F, C, cyl)} con geometría en coordenadas del ensamblaje (mm)."""
    doc = TDocStd_Document(TCollection_ExtendedString("doc"))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    if reader.ReadFile(path) != 1:
        sys.exit(f"No se pudo leer {path}")
    reader.Transfer(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    def name(label):
        attr = TDataStd_Name()
        return attr.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), attr) else "?"

    def color_of(shape, default):
        c = Quantity_Color()
        for t in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
            if ct.GetColor(shape, t, c):
                return (c.Red(), c.Green(), c.Blue())
        return default

    def tessellate(shape, loc_shape, default_col):
        BRepMesh_IncrementalMesh(shape, 0.15, False, 0.35, True)
        V, F, C, cyl = [], [], [], []
        n = 0
        T = loc_shape.Transformation()
        exp = TopExp_Explorer(shape, TopAbs_FACE)
        while exp.More():
            face = TopoDS.Face(exp.Current())
            col = color_of(face, default_col)
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is not None:
                tr = loc_shape.Multiplied(loc).Transformation()
                for i in range(1, tri.NbNodes() + 1):
                    p = tri.Node(i).Transformed(tr)
                    V.append((p.X(), p.Y(), p.Z()))
                rev = face.Orientation() == TopAbs_REVERSED
                for i in range(1, tri.NbTriangles() + 1):
                    a, b, c = tri.Triangle(i).Get()
                    F.append((n + a - 1, n + c - 1, n + b - 1) if rev else (n + a - 1, n + b - 1, n + c - 1))
                    C.append(col)
                n = len(V)
            surf = BRepAdaptor_Surface(face)
            if surf.GetType() == GeomAbs_Cylinder:
                cy = surf.Cylinder()
                ax = cy.Axis().Transformed(T)
                props = GProp_GProps()
                BRepGProp.SurfaceProperties_s(face, props)
                o, d = ax.Location(), ax.Direction()
                cyl.append(((o.X(), o.Y(), o.Z()), (d.X(), d.Y(), d.Z()), cy.Radius(), props.Mass()))
            exp.Next()
        return dict(V=np.array(V, np.float64), F=np.array(F, np.int64), C=np.array(C, np.float32), cyl=cyl)

    parts = {}

    def walk(label, loc, depth):
        ref = TDF_Label()
        if st.IsReference_s(label) and st.GetReferredShape_s(label, ref):
            loc = loc.Multiplied(st.GetLocation_s(label))
            label = ref
        if st.IsAssembly_s(label):
            it = TDF_ChildIterator(label)
            while it.More():
                walk(it.Value(), loc, depth + 1)
                it.Next()
            return
        shape = st.GetShape_s(label)
        nm = name(label)
        parts[nm] = tessellate(shape, loc, color_of(shape, (0.85, 0.85, 0.85)))
        print(f"  {nm}: {len(parts[nm]['F'])} triángulos", flush=True)

    it = TDF_ChildIterator(st.Label())
    while it.More():
        lab = it.Value()
        if st.IsTopLevel(lab) and st.IsFree_s(lab):
            walk(lab, TopLoc_Location(), 0)
        it.Next()
    return parts


# ---------------------------------------------------------------- ejes

def _lines(cyl):
    out = []
    for o, d, r, area in cyl:
        d = np.array(d) / np.linalg.norm(d)
        if d[np.argmax(abs(d))] < 0:
            d = -d
        out.append((np.array(o), d, r, area))
    return out


def _coaxial(a, b, tol=0.05):
    if abs(abs(a[1] @ b[1]) - 1) > 1e-4:
        return False
    v = b[0] - a[0]
    return np.linalg.norm(v - (v @ a[1]) * a[1]) < tol


def find_axis(parent, child):
    """Eje compartido con más superficie entre dos eslabones. Si no hay, el cilindro mayor del hijo."""
    lp, lc = _lines(parent["cyl"]), _lines(child["cyl"])
    groups = []
    for x in lp:
        for y in lc:
            if _coaxial(x, y):
                for g in groups:
                    if _coaxial(g["ref"], x):
                        g["area"] += x[3] + y[3]
                        g["pts"] += [x[0], y[0]]
                        break
                else:
                    groups.append(dict(ref=x, area=x[3] + y[3], pts=[x[0], y[0]]))
    if groups:
        g = max(groups, key=lambda g: g["area"])
        d, pts = g["ref"][1], g["pts"]
    else:
        best = max(lc, key=lambda l: l[3])
        d, pts = best[1], [best[0]]
    # Los ejes de un robot real son ortogonales al marco del CAD: se corrige el ruido de facetas pequeñas.
    k = int(np.argmax(abs(d)))
    if abs(d[k]) > 0.999:
        d = np.zeros(3)
        d[k] = 1.0
    # Punto del eje: media de los orígenes proyectados en el plano normal al eje.
    p = np.mean([q - (q @ d) * d for q in pts], axis=0)
    return p, d


# ---------------------------------------------------------------- malla

def build_meshes(part, palette, transform, ratio):
    """Separa una pieza por color, la transforma y la simplifica. Devuelve [(material, Trimesh)]."""
    V = (transform[:3, :3] @ part["V"].T).T + transform[:3, 3]
    out = []
    keys = np.round(part["C"], 2)
    for key in np.unique(keys, axis=0):
        mask = np.all(keys == key, axis=1)
        mat = palette.get(",".join(f"{k:.2f}" for k in key), palette["default"])
        m = trimesh.Trimesh(V, part["F"][mask], process=True)
        m.merge_vertices(digits_vertex=5)
        m.remove_unreferenced_vertices()
        if ratio < 1 and len(m.faces) > 400:
            v2, f2 = fast_simplification.simplify(m.vertices.astype(np.float32), m.faces.astype(np.int32), 1 - ratio)
            m = trimesh.Trimesh(v2, f2, process=True)
        out.append((mat, m))
    return out


def material(spec):
    return trimesh.visual.material.PBRMaterial(
        name=spec["name"],
        baseColorFactor=[*spec["color"], 1.0],
        metallicFactor=spec.get("metallic", 0.0),
        roughnessFactor=spec.get("roughness", 0.5),
    )


# ---------------------------------------------------------------- main

UP_AXES = {
    "Y": np.eye(3),
    # CAD con Z arriba (Robcad, la mayoría de robots industriales) → Y arriba: (x, y, z) → (x, z, -y).
    "Z": np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float),
}


def r6(v):
    return [round(float(x), 6) + 0.0 for x in v]


def load_parts(cfg, base_dir):
    """{nodo: [pieza]} a partir de un STEP de ensamblaje o de un STEP por pieza."""
    if "arm_step" in cfg:
        print("Leyendo brazo...")
        arm = read_step(os.path.join(base_dir, cfg["arm_step"]))
        missing = [l for l in cfg["links"] if l not in arm]
        if missing:
            sys.exit(f"Faltan piezas en el STEP: {missing}. Disponibles: {list(arm)}")
        return {node: [arm[l]] for l, node in zip(cfg["links"], cfg["node_names"])}
    out = {}
    for node, files in cfg["part_files"].items():
        for f in files:
            print(f"Leyendo {f}...")
            out.setdefault(node, []).extend(read_step(os.path.join(base_dir, f)).values())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    cfg = json.load(open(args.config))
    base_dir = os.path.dirname(os.path.abspath(args.config))
    os.makedirs(args.out, exist_ok=True)

    parts = load_parts(cfg, base_dir)
    up = UP_AXES[cfg.get("up_axis", "Y")]

    # Marco de salida: metros, Y arriba, origen en el eje 1 a la altura del apoyo de la base.
    base_V = np.vstack([p["V"] for p in parts["base"]]) @ up.T
    shift = np.array([0.0, -base_V[:, 1].min(), 0.0])
    to_m = np.eye(4)
    to_m[:3, :3] = up * 0.001
    to_m[:3, 3] = shift * 0.001
    point = lambda p_mm: (up @ np.asarray(p_mm, float) + shift) * 0.001
    direction = lambda d: (up @ np.asarray(d, float)) / np.linalg.norm(d)

    links = []
    if "mechanism" in cfg:
        # Mecanismo explícito (p. ej. tomado de Robcad), con bielas y cierres de lazo.
        for l in cfg["mechanism"]:
            link = dict(name=l["name"], parent=l["parent"], type=l.get("type", "rot"),
                        origin=r6(point(l["origin_mm"])), axis=r6(direction(l["axis"])), drive=dict(l["drive"]))
            if "aim" in link["drive"]:
                aim = dict(link["drive"]["aim"])
                aim["target"] = r6(point(aim.pop("target_mm")))
                link["drive"]["aim"] = aim
            links.append(link)
    else:
        # Cadena serie: ejes detectados en el CAD.
        nodes = cfg["node_names"]
        for i, (a, b) in enumerate(zip(nodes, nodes[1:])):
            p, d = find_axis(parts[a][0], parts[b][0])
            if i == 0 and (up @ d)[1] < 0:
                d = -d
            name = cfg["joint_names"][i]
            links.append(dict(name=b, parent=a, type="rot", origin=r6(point(p)), axis=r6(direction(d)), drive={"q": {name: 1}}))
    for l in links:
        print(f"  {l['name']:6} ← {l['parent']:6} {l['type']} origen {l['origin']} eje {l['axis']} {l['drive']}")

    palette = {k: material(v) for k, v in cfg["palette"].items()}
    scene = trimesh.Scene()
    stats = {}

    def add(node, mat, m, tag):
        m.visual = trimesh.visual.TextureVisuals(material=mat)
        nm = f"{node}__{tag}"
        scene.add_geometry(m, node_name=nm, geom_name=nm)
        stats[node] = stats.get(node, 0) + len(m.faces)

    for node, plist in parts.items():
        for k, part in enumerate(plist):
            for j, (mat, m) in enumerate(build_meshes(part, palette, to_m, cfg["simplify_ratio"])):
                add(node, mat, m, f"{k}_{j}")

    # Herramienta.
    tool = cfg["tool"]
    if "pieces" in tool:
        # Pinza con su propio CAD, montada en la brida.
        T = np.eye(4)
        T[:3, :3] = np.array(tool["rotation"], float)  # columnas: ejes x,y,z de la pinza en el CAD del brazo
        T[:3, 3] = tool["flange_point_mm"]
        T = to_m @ T
        tool_pal = {k: material(v) for k, v in tool["palette"].items()}
        for piece in tool["pieces"]:
            print(f"Leyendo {piece['file']}...")
            for part in read_step(os.path.join(base_dir, piece["file"])).values():
                part["C"][:] = 0.85  # el CAD de la pinza no trae colores
                for j, (_, m) in enumerate(build_meshes(part, {"default": None}, T, cfg["simplify_ratio"])):
                    add(piece["node"], tool_pal[piece["material"]], m, f"{piece['file'][-12:-5]}{j}")
        tcp = (T @ np.array([0, 0, tool["tcp_z_mm"], 1.0]))[:3]
        approach, fingers = T[:3, 2], T[:3, 1]
    else:
        # Brida desnuda: el TCP es el centro de la brida.
        tcp = point(tool["tcp_mm"])
        approach, fingers = direction(tool["approach"]), direction(tool["finger"])
    tool_info = dict(
        link=tool["link"],
        tcp=r6(tcp),
        approach_axis=r6(approach / np.linalg.norm(approach)),
        finger_axis=r6(fingers / np.linalg.norm(fingers)),
        fingers=tool.get("fingers", []),
    )

    glb = os.path.join(args.out, "model.glb")
    scene.export(glb)
    kin = dict(units="m", up="Y", actuated=cfg.get("actuated", cfg.get("joint_names")),
               links=links, tool=tool_info, triangles=stats)
    json.dump(kin, open(os.path.join(args.out, "kinematics.json"), "w"), indent=2)
    print("Triángulos:", stats, "total", sum(stats.values()))
    print(f"Escrito {glb} ({os.path.getsize(glb) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
