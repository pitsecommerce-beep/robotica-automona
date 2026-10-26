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

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    cfg = json.load(open(args.config))
    base_dir = os.path.dirname(os.path.abspath(args.config))
    os.makedirs(args.out, exist_ok=True)

    print("Leyendo brazo...")
    arm = read_step(os.path.join(base_dir, cfg["arm_step"]))
    links = cfg["links"]  # base primero
    missing = [l for l in links if l not in arm]
    if missing:
        sys.exit(f"Faltan piezas en el STEP: {missing}. Disponibles: {list(arm)}")

    # Marco de salida: origen en el centro de la base apoyada en el suelo, metros, Y arriba.
    offset = np.array(cfg.get("origin_offset_mm", [0, 0, 0]), float)
    base_min_y = arm[links[0]]["V"][:, 1].min()
    shift = np.array([offset[0], -base_min_y, offset[2]])
    to_m = np.eye(4)
    to_m[:3, :3] *= 0.001
    to_m[:3, 3] = shift * 0.001

    joints = []
    for i, (a, b) in enumerate(zip(links, links[1:])):
        p, d = find_axis(arm[a], arm[b])
        if i == 0:
            d = d if d[1] >= 0 else -d
        joints.append(dict(
            name=cfg["joint_names"][i],
            parent=cfg["node_names"][i],
            child=cfg["node_names"][i + 1],
            origin=[round(float(x), 6) for x in (p + shift) * 0.001],
            axis=[round(float(x), 6) + 0.0 for x in d],
        ))
        print(f"  {joints[-1]['name']}: origen {joints[-1]['origin']} eje {joints[-1]['axis']}")

    palette = {k: material(v) for k, v in cfg["palette"].items()}
    scene = trimesh.Scene()
    stats = {}
    for link, node in zip(links, cfg["node_names"]):
        for j, (mat, m) in enumerate(build_meshes(arm[link], palette, to_m, cfg["simplify_ratio"])):
            m.visual = trimesh.visual.TextureVisuals(material=mat)
            scene.add_geometry(m, node_name=f"{node}__{j}", geom_name=f"{node}__{j}")
            stats[node] = stats.get(node, 0) + len(m.faces)

    # Herramienta (pinza): cada pieza en su propio STEP, en el marco de la brida.
    tool = cfg.get("tool")
    tool_info = None
    if tool:
        flange = np.array(tool["flange_point_mm"], float)  # en coordenadas del CAD del brazo
        R = np.array(tool["rotation"], float)  # columnas: ejes x,y,z de la pinza en el CAD del brazo
        T = np.eye(4)
        T[:3, :3] = R
        T[:3, 3] = flange
        T = to_m @ T
        tool_pal = {k: material(v) for k, v in tool["palette"].items()}
        for piece in tool["pieces"]:
            print(f"Leyendo {piece['file']}...")
            parts = read_step(os.path.join(base_dir, piece["file"]))
            for part in parts.values():
                part["C"][:] = 0.85  # el CAD de la pinza no trae colores
                for j, (_, m) in enumerate(build_meshes(part, {"default": None}, T, cfg["simplify_ratio"])):
                    m.visual = trimesh.visual.TextureVisuals(material=tool_pal[piece["material"]])
                    nm = f"{piece['node']}__{piece['file'][-12:-5]}{j}"
                    scene.add_geometry(m, node_name=nm, geom_name=nm)
                    stats[piece["node"]] = stats.get(piece["node"], 0) + len(m.faces)
        tcp = T @ np.array([0, 0, tool["tcp_z_mm"], 1.0])
        tool_info = dict(
            flange_origin=[round(float(x), 6) for x in (T @ np.array([0, 0, 0, 1.0]))[:3]],
            tcp=[round(float(x), 6) for x in tcp[:3]],
            approach_axis=[round(float(x), 6) for x in T[:3, 2] / np.linalg.norm(T[:3, 2])],
            finger_axis=[round(float(x), 6) for x in T[:3, 1] / np.linalg.norm(T[:3, 1])],
        )

    glb = os.path.join(args.out, "model.glb")
    scene.export(glb)
    kin = dict(source=os.path.basename(cfg["arm_step"]), units="m", up="Y",
               joints=joints, tool=tool_info, triangles=stats)
    json.dump(kin, open(os.path.join(args.out, "kinematics.json"), "w"), indent=2)
    print("Triángulos:", stats, "total", sum(stats.values()))
    print(f"Escrito {glb} ({os.path.getsize(glb) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
