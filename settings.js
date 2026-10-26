"use strict"

// Settings panel: volume sliders and option toggles. Values are stored in localStorage
// through the Settings class. Everything here is local to the client and never sent online.
class SettingsPanel
{
	static init()
	{
		SettingsPanel.elem = document.getElementById("settings-panel");
		const button = document.getElementById("open-settings");
		ui.toggleSettings.push(button);
		button.addEventListener("click", () => SettingsPanel.open(), false);
		document.getElementById("settings-close").addEventListener("click", () => SettingsPanel.close(), false);
		SettingsPanel.elem.addEventListener("click", e => {
			if (e.target === SettingsPanel.elem)
				SettingsPanel.close();
		});
		document.addEventListener("keydown", e => {
			if (e.key === "Escape" && SettingsPanel.isOpen())
				SettingsPanel.close();
		});

		SettingsPanel.bindVolume("volume-master", Settings.masterVolume, () => {
			SettingsPanel.applySfxVolume();
			SettingsPanel.applyMusicVolume();
		});
		SettingsPanel.bindVolume("volume-music", Settings.musicVolume, SettingsPanel.applyMusicVolume);
		SettingsPanel.bindVolume("volume-sfx", Settings.sfxVolume, SettingsPanel.applySfxVolume);
		// Plays a short sample so the new effects volume can be heard
		["volume-master", "volume-sfx"].forEach(id => document.getElementById(id)
			.addEventListener("change", () => AudioManager.playSFX('ui_card_bank')));

		SettingsPanel.bindToggle("setting-music", () => Settings.music.isEnabled(), () => ui.toggleMusic());
		SettingsPanel.bindToggle("setting-sfx", () => Settings.soundEffects.isEnabled(), () => ui.toggleSFX());
		SettingsPanel.bindToggle("setting-notifications", () => Settings.notifications.isEnabled(), () => ui.toggleNotifications());
	}

	static isOpen() { return !SettingsPanel.elem.classList.contains("hide"); }

	static open()
	{
		SettingsPanel.refresh();
		SettingsPanel.elem.classList.remove("hide");
		AudioManager.playSFX('menu_opening');
	}

	static close()
	{
		SettingsPanel.elem.classList.add("hide");
	}

	// Syncs the controls with the current settings (they can also change through the quick toggle buttons)
	static refresh()
	{
		SettingsPanel.elem.querySelectorAll("input").forEach(input => input.refresh?.());
	}

	static bindVolume(id, option, apply)
	{
		const input = document.getElementById(id);
		const output = SettingsPanel.elem.querySelector(`output[for="${id}"]`);
		input.refresh = () => {
			input.value = option.get();
			output.textContent = option.get() + "%";
		};
		input.addEventListener("input", () => {
			option.set(input.value);
			output.textContent = option.get() + "%";
			apply();
		});
		input.refresh();
	}

	static bindToggle(id, isEnabled, toggle)
	{
		const input = document.getElementById(id);
		input.refresh = () => input.checked = isEnabled();
		input.addEventListener("change", () => {
			if (input.checked !== isEnabled())
				toggle();
			input.refresh();
		});
		input.refresh();
	}

	static applySfxVolume()
	{
		const level = Settings.sfxLevel();
		Object.values(AudioManager.source).forEach(audio => {
			if (audio instanceof Audio)
				audio.volume = level;
		});
	}

	static applyMusicVolume()
	{
		if (!ui.ytActive)
			return;
		ui.youtube.unMute();
		ui.youtube.setVolume(Settings.musicLevel() * 100);
	}
}

SettingsPanel.init();
