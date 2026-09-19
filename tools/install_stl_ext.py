import bpy
bpy.context.preferences.system.use_online_access = True
print("syncing...")
bpy.ops.extensions.repo_sync_all()
print("installing stl_format_legacy...")
bpy.ops.extensions.package_install(repo_index=0, pkg_id="stl_format_legacy", enable_on_install=True)
print("INSTALL_DONE")