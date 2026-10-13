UUID := $(shell sed -n 's/.*"uuid": *"\(.*\)".*/\1/p' metadata.json)
ZIP  := $(UUID).shell-extension.zip

.PHONY: pack install uninstall clean

# Build the installable zip (compiles the settings schema into it)
pack: $(ZIP)

$(ZIP): extension.js metadata.json stylesheet.css schemas/*.gschema.xml
	gnome-extensions pack --force --out-dir .

# Install for the current user; log out and back in afterwards
install: $(ZIP)
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
