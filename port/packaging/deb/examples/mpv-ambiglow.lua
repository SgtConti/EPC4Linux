-- mpv script: Ambiglow "Follow video" while mpv plays a video, the previous effect back when mpv quits.
--
-- Install: copy to ~/.config/mpv/scripts/ (the Debian package ships it in
-- /usr/share/doc/evnia-precision-center/examples/). Evnia Precision Center starts hidden if it is not running.
-- On GNOME Wayland the first Follow video of an app run asks once which screen to share.
--
-- Options (~/.config/mpv/script-opts/mpv-ambiglow.conf):
--   effect=FollowVideo        what to switch to (any --ambiglow value: an effect name, on, off)
--   command=evnia-precision-center

local options = { effect = 'FollowVideo', command = 'evnia-precision-center' }
require('mp.options').read_options(options, 'mpv-ambiglow')

local active = false

local function ambiglow(value)
  -- Detached: the call returns at once, and the restore still runs when mpv exits right after.
  mp.command_native({ name = 'subprocess', args = { options.command, '--ambiglow=' .. value },
                      playback_only = false, detach = true })
end

mp.register_event('file-loaded', function()
  local video = mp.get_property_native('current-tracks/video')
  if active or not video or video.image or video.albumart then return end
  active = true
  ambiglow(options.effect)
end)

mp.register_event('shutdown', function()
  if active then ambiglow('restore') end
end)
