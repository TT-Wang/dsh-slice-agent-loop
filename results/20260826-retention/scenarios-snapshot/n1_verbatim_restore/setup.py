import os
def setup(root):
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    os.makedirs(os.path.join(root, "restored"), exist_ok=True)
    open(os.path.join(root, "lib", "util.py"), "w").write("# util\n")
