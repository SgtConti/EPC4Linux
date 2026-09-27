# Legal notice

- **Unofficial.** This is an independent project, not affiliated with, authorised, endorsed or supported by Philips, Top Victory Investments Ltd. (TPV/MMD) or Zeasn. "Philips", "Evnia" and "Ambiglow" are trademarks of their respective owners and are used only to describe compatibility.
- **No vendor software included.** Evnia Precision Center is proprietary software of its respective owners. This repository does not contain or distribute it. The port was built by analysing that software solely to make independently written software interoperate with hardware you own.
- **Bring your own copy.** Building requires your own lawfully obtained copy of Evnia Precision Center 1.13.0. The build extracts and modifies parts of it (the user interface and three data files), so the build output (`port/build/`) and the resulting packages (`.deb`) contain the vendor's proprietary material. They are for **personal use only; do not redistribute them.**
- **Documentation.** `docs/re/` describes the behaviour of the original software and quotes only short fragments where needed for interoperability.
- **No warranty.** Provided "as is". Changing monitor settings over DDC/CI and USB is at your own risk; "Reset profile" and "Factory reset" also reset the monitor itself.

## Licence

The project's own code and documentation (`port/`, `tools/`, `docs/`) are licensed under the [MIT License](LICENSE). That licence does **not** extend to the vendor's software or to any material extracted from it, including the contents of `port/build/` and the packages built from it.
