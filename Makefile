XPI = workspaces.xpi

SOURCES = manifest.json \
          background.js \
          $(wildcard popup/*) \
          $(wildcard restore/*) \
          $(wildcard icons/*)

.PHONY: all clean

all: $(XPI)

$(XPI): $(SOURCES)
	@rm -f $@
	zip -r $@ manifest.json background.js popup/ restore/ icons/

clean:
	rm -f $(XPI)
