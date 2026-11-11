"""Whether Windows reports the current internet connection as metered.

Stdlib-only: the launcher decides the update-check default before the server starts.
"""

from __future__ import annotations

import sys
import uuid
from ctypes import (
    POINTER,
    WINFUNCTYPE,
    HRESULT,
    Structure,
    WinDLL,
    byref,
    c_ubyte,
    c_ulong,
    c_ushort,
    c_void_p,
    cast,
)

# Windows "Set as metered connection", plus mobile/roaming/data-cap costs.
_METERED_COST = 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000
_NETWORK_LIST_MANAGER = "{DCB00C01-570F-4A9B-8D69-199FDBA5723B}"
_NETWORK_COST_MANAGER = "{DCB00000-570F-4A9B-8D69-199FDBA5723B}"


class _GUID(Structure):
    _fields_ = [
        ("Data1", c_ulong),
        ("Data2", c_ushort),
        ("Data3", c_ushort),
        ("Data4", c_ubyte * 8),
    ]


def _guid(text: str) -> _GUID:
    return _GUID.from_buffer_copy(uuid.UUID(text).bytes_le)


def connection_is_metered() -> bool:
    """True when the machine-wide internet connection is metered. False if it cannot be read."""
    if sys.platform != "win32":
        return False
    try:
        return _windows_connection_is_metered()
    except OSError:
        return False


def updates_on_start_enabled(settings: dict) -> bool:
    """Stored checkbox, or the metered-connection default when the user has never set it."""
    if "check_browser_updates_on_start" in settings:
        return bool(settings["check_browser_updates_on_start"])
    return not connection_is_metered()


def _windows_connection_is_metered() -> bool:
    ole32 = WinDLL("ole32")
    ole32.CoInitializeEx.argtypes = [c_void_p, c_ulong]
    ole32.CoInitializeEx.restype = HRESULT
    ole32.CoCreateInstance.argtypes = [
        POINTER(_GUID),
        c_void_p,
        c_ulong,
        POINTER(_GUID),
        POINTER(c_void_p),
    ]
    ole32.CoCreateInstance.restype = HRESULT
    ole32.CoUninitialize.argtypes = []

    # 2 = COINIT_APARTMENTTHREADED. S_OK starts a new init; anything else leaves it alone.
    started = ole32.CoInitializeEx(None, 2) == 0
    manager = c_void_p()
    try:
        hr = ole32.CoCreateInstance(
            byref(_guid(_NETWORK_LIST_MANAGER)),
            None,
            1,  # CLSCTX_INPROC_SERVER
            byref(_guid(_NETWORK_COST_MANAGER)),
            byref(manager),
        )
        if hr < 0 or not manager.value:
            return False
        vtable = cast(manager, POINTER(POINTER(c_void_p))).contents
        # INetworkCostManager::GetCost is vtable slot 3. NULL address = machine-wide connection.
        get_cost = WINFUNCTYPE(HRESULT, c_void_p, POINTER(c_ulong), c_void_p)(vtable[3])
        cost = c_ulong()
        if get_cost(manager, byref(cost), None) < 0:
            return False
        return bool(cost.value & _METERED_COST)
    finally:
        if manager.value:
            release = WINFUNCTYPE(c_ulong, c_void_p)(
                cast(manager, POINTER(POINTER(c_void_p))).contents[2]
            )
            release(manager)
        if started:
            ole32.CoUninitialize()
