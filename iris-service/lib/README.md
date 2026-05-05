# `iris-service/lib/` — vendor JARs (not redistributable)

This directory holds the Mantra `Marvis_Auth.jar` that the `.deb` build
script bundles into `mantra-iris-service`. The JAR is large (~267 MB
because it ships native `.so`/`.dll` bundles for Linux + Windows) and is
not redistributable, so it is not committed to source control.

## Where the JAR comes from

`Marvis_Auth_Linux_Java_1.0.0.0/Libs/Marvis_Auth.jar` in the vendor
package shipped by Mantra. Copy it here:

```bash
cp /path/to/Marvis_Auth_Linux_Java_1.0.0.0/Libs/Marvis_Auth.jar \
   iris-service/lib/Marvis_Auth.jar
```

## What's actually inside the JAR

Despite the "Linux" name on the vendor package, the JAR is platform-portable:

- `linux/x86/`, `linux/x86_64/` — Linux `.so` natives
- `win/x86/`, `win/x64/`         — Windows `.dll` natives
- `com/mantra/marvisauth/...`    — pure Java code; uses `os.name` /
                                   `os.arch` at runtime to pick natives

Same JAR therefore runs on both Linux and Windows operator laptops.

## Why we don't depend on the JAR at compile time

`pom.xml` doesn't reference this JAR. `MarvisIrisProvider` calls into the
SDK by **reflection** so contributors can build and unit-test
`mantra-iris-service` (against the mock provider) without ever copying
the vendor JAR. The JAR is only needed when:

1. Building the production `.deb` (`./build-deb.sh` checks for
   `lib/Marvis_Auth.jar` and fails fast if it's missing).
2. Running with `IRIS_PROVIDER=marvis` or `marvis-strict` against real
   hardware.
