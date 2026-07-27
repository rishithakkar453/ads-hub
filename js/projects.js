/* ============================================================================
   ADS HUB — My Projects
   Every product/site you advertise is a persistent project: its full brief
   (URL, scraped site, notes, documents, images, uploaded videos) plus the last
   generated batch. This view lists them all — open one and the generator is
   restored exactly as you left it. Registered as the 'projects' view.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var store = Ads.store, util = Ads.util;
  var esc = util.escapeHtml;
  function icons() { return Ads.icons; }

  function srcSummary(p) {
    var b = p.brief || {}, bits = [];
    if (b.site || (b.url || '').trim()) bits.push('website');
    if ((b.files || []).length) bits.push(b.files.length + ' doc' + (b.files.length > 1 ? 's' : ''));
    if ((b.images || []).length) bits.push(b.images.length + ' image' + (b.images.length > 1 ? 's' : ''));
    if ((b.videos || []).length) bits.push(b.videos.length + ' video' + (b.videos.length > 1 ? 's' : ''));
    return bits.join(' · ') || 'no sources yet';
  }
  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso), diff = Date.now() - d.getTime();
    if (diff < 60e3) return 'just now';
    if (diff < 3600e3) return Math.round(diff / 60e3) + 'm ago';
    if (diff < 86400e3) return Math.round(diff / 3600e3) + 'h ago';
    if (diff < 7 * 86400e3) return Math.round(diff / 86400e3) + 'd ago';
    return d.toLocaleDateString();
  }

  function card(p) {
    var thumb = p.thumb
      ? '<div class="proj-thumb" style="background-image:url(' + p.thumb.replace(/"/g, '&quot;') + ')"></div>'
      : '<div class="proj-thumb is-empty">' + esc((p.name || 'P').slice(0, 1).toUpperCase()) + '</div>';
    var nAds = (p.results || []).length;
    return '<div class="proj-card" data-open="' + esc(p.id) + '" title="Open this project">' +
      thumb +
      '<div class="proj-body">' +
        '<div class="proj-name u-truncate">' + esc(p.name || 'Untitled project') + '</div>' +
        ((p.dossier && p.dossier.sections && p.dossier.sections.summary)
          ? '<div class="proj-desc">' + esc(String(p.dossier.sections.summary).slice(0, 150)) + (String(p.dossier.sections.summary).length > 150 ? '…' : '') + '</div>'
          : '') +
        '<div class="proj-meta">' + esc(srcSummary(p)) + (nAds ? ' · ' + nAds + ' ads' : '') + '</div>' +
        '<div class="proj-meta is-faint">Updated ' + esc(when(p.updatedAt)) + '</div>' +
        '<div class="proj-actions">' +
          '<button class="btn is-primary is-sm" data-open="' + esc(p.id) + '">Open</button>' +
          '<button class="btn is-ghost is-sm" data-rename="' + esc(p.id) + '" data-stop="1">Rename</button>' +
          '<button class="btn is-ghost is-sm" data-del="' + esc(p.id) + '" data-stop="1">Delete</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderProjects(el) {
    var projects = store.listProjects();
    if (!projects.length) {
      el.innerHTML = '<div class="empty"><div class="empty-title">No projects yet</div>' +
        '<div>Point the generator at a website or upload a video — a project is created automatically and everything you add is saved here.</div>' +
        '<div class="btn-row" style="justify-content:center;margin-top:1.6rem">' +
          '<button class="btn is-primary" data-goto-gen="1"><span class="btn-ico">' + icons().sparkle + '</span> Open the generator</button>' +
        '</div></div>';
      var g = el.querySelector('[data-goto-gen]');
      if (g) g.addEventListener('click', function () { Ads.go('generator'); });
      return;
    }
    el.innerHTML =
      '<div class="proj-head"><span class="u-label">' + projects.length + ' project' + (projects.length > 1 ? 's' : '') + ' — everything you upload is saved and restored</span>' +
        '<button class="btn is-sm" id="proj-new"><span class="btn-ico">' + icons().plus + '</span> New project</button></div>' +
      '<div class="proj-grid">' + projects.map(card).join('') + '</div>';

    el.querySelector('#proj-new').addEventListener('click', function () { Ads.gen.newProject(); });

    el.querySelectorAll('[data-open]').forEach(function (n) {
      n.addEventListener('click', function (e) {
        if (e.target.closest('[data-stop]')) return;
        Ads.gen.openProject(n.getAttribute('data-open'));
      });
    });
    el.querySelectorAll('[data-rename]').forEach(function (n) {
      n.addEventListener('click', function () {
        var id = n.getAttribute('data-rename'), p = store.getProject(id);
        if (!p) return;
        Ads.form({
          title: 'Rename project',
          fields: [{ name: 'name', label: 'Project name', default: p.name }],
          submitLabel: 'Rename',
          onSubmit: function (data) {
            var name = (data.name || '').trim();
            if (name) store.updateProject(id, { name: name });
            Ads.closeModal(); Ads.app.render();
          }
        });
      });
    });
    el.querySelectorAll('[data-del]').forEach(function (n) {
      n.addEventListener('click', function () {
        var id = n.getAttribute('data-del'), p = store.getProject(id);
        if (!p) return;
        Ads.confirm({
          title: 'Delete "' + (p.name || 'this project') + '"?',
          message: 'This removes the project, its saved uploads and its generated ads. Approved ads in Performance are kept.',
          danger: true, okLabel: 'Delete',
          onConfirm: function () {
            store.deleteProject(id);
            // remove the stored upload files on the server too (best-effort)
            fetch('/api/project-files/delete', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
              body: JSON.stringify({ project: id })
            }).catch(function () {});
            if (Ads.gen.currentProjectId && Ads.gen.currentProjectId() === id) Ads.gen.newProject();
            else Ads.app.render();
            Ads.toast('Project deleted');
          }
        });
      });
    });
  }

  Ads.registerView('projects', { title: 'My Projects', mode: 'generator', render: renderProjects });
})();
