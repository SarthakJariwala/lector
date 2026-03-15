UNAME_S := $(shell uname -s)

APP_NAME ?= Lector
APPLICATIONS_DIR ?= /Applications
TAURI_BUNDLE_APP_PATH := src-tauri/target/release/bundle/macos/$(APP_NAME).app
INSTALLED_APP_PATH := $(APPLICATIONS_DIR)/$(APP_NAME).app

.PHONY: build build-install

build:
	@if [ "$(UNAME_S)" != "Darwin" ]; then \
		echo "make build is only supported on macOS."; \
		exit 1; \
	fi
	cargo tauri build --bundles app

build-install: build
	@if [ "$(UNAME_S)" != "Darwin" ]; then \
		echo "make build-install is only supported on macOS."; \
		exit 1; \
	fi
	@if [ ! -d "$(TAURI_BUNDLE_APP_PATH)" ]; then \
		echo "Built app not found at $(TAURI_BUNDLE_APP_PATH)."; \
		exit 1; \
	fi
	@echo "Installing $(APP_NAME).app into $(APPLICATIONS_DIR)..."
	@rm -rf "$(INSTALLED_APP_PATH)"
	@ditto "$(TAURI_BUNDLE_APP_PATH)" "$(INSTALLED_APP_PATH)"
	@echo "Installed $(INSTALLED_APP_PATH)"
