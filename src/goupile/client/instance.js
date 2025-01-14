// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see https://www.gnu.org/licenses/.

import { render, html, svg } from '../../../vendor/lit-html/lit-html.bundle.js';
import { Util, Log, Net, LruMap, Mutex, LocalDate, LocalTime } from '../../web/libjs/common.js';
import { Sha256 } from '../../web/libjs/crypto.js';
import * as goupile from './goupile.js';
import { profile } from './goupile.js';
import * as UI from './ui.js';
import { exportRecords } from './data_export.js';
import { ApplicationInfo, ApplicationBuilder } from './instance_app.js';
import { FormState, FormModel, FormBuilder } from './form.js';
import { MagicData } from './form_data.js';
import { MetaModel, MetaInterface } from './form_meta.js';

import './instance.css';

let app = null;

// Explicit mutex to serialize (global) state-changing functions
let mutex = new Mutex;

let route = {
    tid: null,
    anchor: null,
    page: null,
    menu: null
};

let main_works = true;
let head_length = Number.MAX_SAFE_INTEGER;
let page_div = document.createElement('div');

let form_thread = null;
let form_entry = null;
let form_data = null;
let form_state = null;
let form_model = null;
let form_builder = null;

let data_tags = null;
let data_threads = null;
let data_columns = null;
let data_rows = null;

let code_buffers = new LruMap(32);
let code_builds = new LruMap(4);
let fs_timer = null;

let editor_el;
let editor_ace;
let editor_filename;

let ignore_editor_change = false;
let ignore_editor_scroll = 0;
let ignore_page_scroll = 0;

let error_entries = {
    app: new Log.Entry,
    page: new Log.Entry
};

async function init(fallback) {
    if (profile.develop) {
        ENV.urls.files = `${ENV.urls.base}files/0/`;
        ENV.version = 0;
    }

    await initApp(fallback);
    initUI();

    if (profile.develop)
        uploadFsChanges();
}

async function initApp(fallback) {
    try {
        let new_app = await runMainScript();

        new_app.homepage = new_app.pages[0];
        app = Util.deepFreeze(new_app);
    } catch (err) {
        if (fallback) {
            let new_app = new ApplicationInfo(profile);
            let builder = new ApplicationBuilder(new_app);

            // For simplicity, a lot of code assumes at least one page exists
            builder.form('default', 'Défaut', 'Page par défaut');

            new_app.homepage = new_app.pages[0];
            app = Util.deepFreeze(new_app);

            error_entries.app.error(err, -1);
        } else {
            throw err;
        }
    }

    if (app.head != null) {
        let container = document.createElement('div');
        render(app.head, container);

        // Clear previous changes
        for (let i = document.head.children.length - 1; i >= head_length; i--)
            document.head.removeChild(document.head.children[i]);
        head_length = document.head.children.length;

        for (let child of container.children)
            document.head.appendChild(child);
    }
}

async function runMainScript() {
    let buffer = await fetchCode('main.js');

    let new_app = new ApplicationInfo(profile);
    let builder = new ApplicationBuilder(new_app);

    try {
        let func = await buildScript(buffer.code, ['app']);

        await func({
            app: builder
        });
        if (!new_app.pages.length)
            throw new Error('Main script does not define any page');

        error_entries.app.close();
        main_works = true;
    } catch (err) {
        main_works = false;
        throw err;
    }

    return new_app;
}

function initUI() {
    UI.setMenu(renderMenu);

    if (app.panels.editor)
        UI.createPanel('editor', 0, renderEditor);
    if (app.panels.data)
        UI.createPanel('data', app.panels.editor ? 1 : 0, renderData);
    UI.createPanel('view', 1, renderPage);

    if (app.panels.editor) {
        UI.setPanels(['editor', 'view']);
    } else if (app.panels.data) {
        UI.setPanels(['data']);
    } else {
        UI.setPanels(['view']);
    }
}

function hasUnsavedData() {
    if (fs_timer != null)
        return true;

    if (form_state == null)
        return false;
    if (route.page.store == null)
        return false;
    if (!route.page.options.warn_unsaved)
        return false;

    return form_state.hasChanged();
}

async function runTasks(online) {
    await mutex.run(async() => {
        // Nothing to do for now
    });
}

function renderMenu() {
    let show_menu = (profile.lock == null && (route.menu.chain.length > 2 || route.menu.chain[0].children.length > 1));
    let show_title = !show_menu;
    let menu_is_wide = (show_menu && route.menu.chain[0].children.length > 3);

    if (!UI.isPanelActive('editor') && !UI.isPanelActive('view'))
        show_menu = false;

    let user_icon = goupile.isLoggedOnline() ? 450 : 494;

    return html`
        <nav class=${goupile.isLocked() ? 'ui_toolbar locked' : 'ui_toolbar'} id="ui_top" style="z-index: 999999;">
            ${goupile.hasPermission('build_code') ? html`
                <div class="drop">
                    <button class=${'icon' + (profile.develop ? ' active' : '')}
                            style="background-position-y: calc(-230px + 1.2em);"
                            @click=${UI.deployMenu}>Conception</button>
                    <div>
                        <button class=${profile.develop ? 'active' : ''}
                                @click=${UI.wrap(e => goupile.changeDevelopMode(!profile.develop))}>
                            <div style="flex: 1;">Mode conception</div>
                            ${profile.develop ? html`<div>&nbsp;✓\uFE0E</div>` : ''}
                        </button>
                    </div>
                </div>
            ` : ''}
            ${profile.lock != null ? html`
                <button class="icon" style="background-position-y: calc(-186px + 1.2em)"
                        @click=${UI.wrap(goupile.runUnlockDialog)}>Déverrouiller</button>
            ` : ''}

            ${app.panels.editor || app.panels.data ? html`
                <div style="width: 8px;"></div>
                ${app.panels.editor ? html`
                    <button class=${!UI.hasTwoPanels() && UI.isPanelActive('editor') ? 'icon active' : 'icon'}
                            style="background-position-y: calc(-230px + 1.2em);"
                            @click=${UI.wrap(e => togglePanels(true, false))}></button>
                ` : ''}
                ${app.panels.data && !app.panels.editor ? html`
                    <button class=${!UI.hasTwoPanels() && UI.isPanelActive('data') ? 'icon active' : 'icon'}
                            style="background-position-y: calc(-274px + 1.2em);"
                            @click=${UI.wrap(e => togglePanels(true, false))}></button>
                ` : ''}
                ${UI.allowTwoPanels() ? html`
                    <button class=${UI.hasTwoPanels() ? 'icon active' : 'icon'}
                            style="background-position-y: calc(-626px + 1.2em);"
                            @click=${UI.wrap(e => togglePanels(true, true))}></button>
                ` : ''}
                <button class=${!UI.hasTwoPanels() && UI.isPanelActive(1) ? 'icon active' : 'icon'}
                        style="background-position-y: calc(-318px + 1.2em);"
                        @click=${UI.wrap(e => togglePanels(false, true))}></button>
            ` : ''}
            <div style="flex: 1; min-width: 4px;"></div>

            ${show_menu && !menu_is_wide ? Util.map(route.menu.chain[0].children, item => {
                if (item.children.length) {
                    let active = route.menu.chain.includes(item);

                    return html`
                        <div id="ins_drop" class="drop">
                            <button title=${item.title} class=${active ? 'active' : ''}
                                    @click=${UI.deployMenu}>${item.title}</button>
                            <div>${Util.map(item.children, item => renderDropItem(item))}</div>
                        </div>
                    `;
                } else {
                    return renderDropItem(item);
                }
            }) : ''}
            ${show_menu && menu_is_wide ? route.menu.chain.map(item => {
                if (item.children.length) {
                    return html`
                        <div id="ins_drop" class="drop">
                            <button title=${item.title} @click=${UI.deployMenu}>${item.title}</button>
                            <div>${Util.map(item.children, child => renderDropItem(child))}</div>
                        </div>
                    `;
                } else {
                    return renderDropItem(item);
                }
            }) : ''}
            ${show_title ? html`<button title=${route.page.title} class="active">${route.page.title}</button>` : ''}
            ${app.panels.data && (!UI.isPanelActive('view') || form_thread.saved) ? html`
                <div style="width: 15px;"></div>
                <button class="icon" style="background-position-y: calc(-758px + 1.2em);"
                        @click=${UI.wrap(e => go(e, route.page.url))}>Ajouter</button>
            ` : ''}
            <div style="flex: 1; min-width: 4px;"></div>

            ${!goupile.isLocked() && profile.instances == null ?
                html`<button class="icon" style="background-position-y: calc(-538px + 1.2em);"
                             @click=${e => go(e, ENV.urls.instance)}>${ENV.title}</button>` : ''}
            ${!goupile.isLocked() && profile.instances != null ? html`
                <div class="drop right" @click=${UI.deployMenu}>
                    <button class="icon" style="background-position-y: calc(-538px + 1.2em);"
                            @click=${UI.deployMenu}>${ENV.title}</button>
                    <div>
                        ${profile.instances.slice().sort(Util.makeComparator(instance => instance.name))
                                           .map(instance =>
                            html`<button class=${instance.url === ENV.urls.instance ? 'active' : ''}
                                         @click=${e => go(e, instance.url)}>${instance.name}</button>`)}
                    </div>
                </div>
            ` : ''}
            ${profile.lock == null ? html`
                <div class="drop right">
                    <button class="icon" style=${'background-position-y: calc(-' + user_icon + 'px + 1.2em);'}
                            @click=${UI.deployMenu}>${profile.type !== 'auto' ? profile.username : ''}</button>
                    <div>
                        ${profile.type === 'auto' && profile.userid ? html`
                            <button style="text-align: center;">
                                ${profile.username}<br/>
                                <span style="font-size: 0.8em; font-style: italic; color: #555;">Identifiant temporaire</span>
                            </button>
                            <hr/>
                        ` : ''}
                        ${profile.type === 'login' ? html`
                            <button @click=${UI.wrap(goupile.runChangePasswordDialog)}>Modifier mon mot de passe</button>
                            <button @click=${UI.wrap(goupile.runResetTOTP)}>Configurer la double authentification</button>
                            <hr/>
                            ${goupile.hasPermission('data_export') ? html`
                                <button @click=${UI.wrap(generateExportKey)}>Générer une clé d'export</button>
                                <hr/>
                            ` : ''}
                        ` : ''}
                        ${profile.root || goupile.hasPermission('build_admin') ? html`
                            <button @click=${e => window.open('/admin/')}>Administration</button>
                            <hr/>
                        ` : ''}
                        ${profile.userid < 0 ? html`<button @click=${UI.wrap(goupile.logout)}>Changer de compte</button>` : ''}
                        <button @click=${UI.wrap(goupile.logout)}>${profile.userid ? 'Se déconnecter' : 'Se connecter'}</button>
                    </div>
                </div>
            ` : ''}
            ${profile.lock != null ?
                html`<button class="icon" @click=${UI.wrap(goupile.goToLogin)}
                             style="background-position-y: calc(-450px + 1.2em);">Se connecter</button>` : ''}
        </nav>
    `;
}

async function generateExportKey(e) {
    let export_key = await Net.post(`${ENV.urls.instance}api/change/export_key`);

    await UI.dialog(e, 'Clé d\'export', {}, (d, resolve, reject) => {
        d.text('export_key', 'Clé d\'export', {
            value: export_key,
            readonly: true
        });
    });
}

function renderDropItem(item) {
    let active = route.menu.chain.includes(item);
    let url = contextualizeURL(item.url, form_thread);

    return html`
        <button class=${active ? 'active' : ''}
                @click=${UI.wrap(e => active ? togglePanels(null, true) : go(e, url))}>
            <div style="flex: 1;">${item.title}</div>
       </button>
    `;
}

async function togglePanels(left, right) {
    UI.togglePanel(0, left);

    if (typeof right == 'string') {
        UI.togglePanel(right, true);
    } else if (right != null) {
        UI.togglePanel(1, right);
    }

    await run();

    // Special behavior for some panels
    if (left) {
        syncFormScroll();
        syncFormHighlight(true);
    }
    if (right) {
        syncEditorScroll();
        syncFormHighlight(false);
    }
}

function renderEditor() {
    // Ask ACE to adjust if needed, it needs to happen after the render
    setTimeout(() => editor_ace.resize(false), 0);

    let tabs = getEditorTabs();
    let active_tab = tabs.find(tab => tab.active);

    return html`
        <div style="--menu_color: #1d1d1d; --menu_color_n1: #2c2c2c;">
            <div class="ui_toolbar">
                <div class="drop">
                    <button @click=${UI.deployMenu}>${active_tab.title}</button>
                    <div>
                        ${tabs.map(tab => html`<button class=${UI.isPanelActive('editor') && tab.active ? 'active' : ''}
                                                       @click=${UI.wrap(e => toggleEditorFile(e, tab.filename))}>${tab.title}</button>`)}
                    </div>
                </div>
                <div style="flex: 1;"></div>
                <button @click=${UI.wrap(e => runHistoryDialog(e, editor_filename))}>Historique</button>
                <div style="flex: 1;"></div>
                ${editor_filename === 'main.js' ? html`
                    <button ?disabled=${!main_works || !fileHasChanged('main.js')}
                            @click=${e => { window.location.href = window.location.href; }}>Appliquer</button>
                ` : ''}
                <button @click=${UI.wrap(runPublishDialog)}>Publier</button>
            </div>

            ${editor_el}
        </div>
    `;
}

function getEditorTabs() {
    let tabs = [];

    tabs.push({
        title: 'Projet',
        filename: 'main.js',
        active: false
    });
    tabs.push({
        title: 'Formulaire',
        filename: route.page.filename,
        active: false
    });

    for (let tab of tabs)
        tab.active = (editor_filename == tab.filename);

    return tabs;
}

async function runHistoryDialog(e, filename) {
    await uploadFsChanges();
    await fetchCode(filename);

    let url = Util.pasteURL(`${ENV.urls.base}api/files/history`, { filename: filename });
    let versions = await Net.get(url);

    let buffer = code_buffers.get(filename);
    let copy = Object.assign({}, code_buffers.get(filename));

    // Don't trash the undo/redo buffer
    buffer.session = null;

    let p = UI.dialog(e, 'Historique du fichier', {}, (d, resolve, reject) => {
        d.output(html`
            <table class="ui_table">
                <colgroup>
                    <col/>
                    <col/>
                    <col/>
                </colgroup>

                <tbody>
                    <tr class=${buffer.version == 0 ? 'active' : ''}>
                        <td class="ui_sub">(dev)</td>
                        <td>En développement</td>
                        <td><a @click=${UI.wrap(e => loadFile(filename, 0))}>Charger</a></td>
                    </tr>

                    ${Util.mapRange(0, versions.length - 1, idx => {
                        let version = versions[versions.length - idx - 1];

                        return html`
                            <tr class=${buffer.version == version.version ? 'active' : ''}>
                                <td class="ui_sub">${version.version}</td>
                                <td>${(new Date(version.mtime)).toLocaleString()}</td>
                                <td><a @click=${UI.wrap(e => loadFile(filename, version.version))}>Charger</a></td>
                            </tr>
                        `;
                    })}
                </tbody>
            </table>
        `);

        d.action('Restaurer', { disabled: !d.isValid() || buffer.version == 0 }, async () => {
            await restoreFile(filename, buffer.sha256);
            resolve();
        });
    });
    p.catch(async err => {
        code_buffers.set(filename, copy);

        if (filename == 'main.js') {
            try {
                await runMainScript();
            } catch (err) {
                error_entries.app.error(err, -1);
            }
        }
        run();

        throw err;
    });

    return p;
}

async function loadFile(filename, version) {
    let url = `${ENV.urls.base}files/${version}/${filename}`;
    let response = await Net.fetch(url);

    if (response.ok) {
        let code = await response.text();
        updateBuffer(filename, code, version);

        return run();
    } else if (response.status == 404) {
        updateBuffer(filename, '', version);
        return run();
    } else {
        let err = await Net.readError(response);
        throw new Error(err);
    }
}

async function restoreFile(filename, sha256) {
    let db = await goupile.openLocalDB();

    await Net.post(`${ENV.urls.base}api/files/restore`, {
        filename: filename,
        sha256: sha256
    });

    let key = `${profile.userid}/${filename}`;
    await db.delete('changes', key);

    code_buffers.delete(filename);

    return run();
}

function renderData() {
    let recording_new = !form_thread.saved && form_state.hasChanged();

    return html`
        <div class="padded">
            <div class="ui_quick" style="margin-right: 2.2em;">
                <div style="display: flex; gap: 8px; padding-bottom: 4px;">
                    <div class="fm_check">
                        <input id="ins_tags" type="checkbox" .checked=${data_tags != null}
                               @change=${UI.wrap(e => toggleTagFilter(null))} />
                        <label for="ins_tags">Filtrer :</label>
                    </div>
                    ${app.tags.map(tag => {
                        let id = 'ins_tag_' + tag.key;

                        return html`
                            <div  class=${data_tags == null ? 'fm_check disabled' : 'fm_check'} style="padding-top: 0;">
                                <input id=${id} type="checkbox"
                                       .checked=${data_tags == null || data_tags.has(tag.key)}
                                       @change=${UI.wrap(e => toggleTagFilter(tag.key))} />
                                <label for=${id}><span class="ui_tag" style=${'background: ' + tag.color + ';'}>${tag.label}</label>
                            </div>
                        `;
                    })}
                </div>
            </div>

            <table class="ui_table fixed" id="ins_data"
                   style=${'min-width: ' + (5 + 5 * data_columns.length) + 'em;'}>
                <colgroup>
                    <col style="width: 60px;" />
                    <col style="width: 8em;"/>
                    ${Util.mapRange(0, data_columns.length, () => html`<col/>`)}
                    <col style="width: 2em;"/>
                </colgroup>

                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Création</th>
                        ${data_columns.map(col => {
                            let stats = `${col.count} / ${data_rows.length}`;
                            let title = `${col.title}\nDisponible : ${stats} ${data_rows.length > 1 ? 'lignes' : 'ligne'}`;

                            return html`
                                <th title=${title}>
                                    ${col.title}<br/>
                                    <span style="font-size: 0.7em; font-weight: normal;">${stats}</span>
                                </th>
                            `;
                        })}
                    </tr>
                </thead>

                <tbody>
                    ${data_rows.map(row => {
                        let active = (row.tid == route.tid);
                        let cls = (row.sequence == null ? 'missing' : '') + (active ? ' active' : '');

                        return html`
                            <tr>
                                <td class=${cls} title=${row.sequence}>${row.sequence != null ? row.sequence : 'NA'}</td>
                                <td class=${active ? ' active' : ''} title=${row.ctime.toLocaleString()}>${row.ctime.toLocaleDateString()}</td>
                                ${data_columns.map(col => {
                                    let entry = row.entries[col.store];
                                    let url = col.url + `/${row.tid}`;

                                    if (entry != null) {
                                        let tags = app.tags.filter(tag => entry.tags.includes(tag.key));

                                        let tooltip = 'Créé : ' + entry.ctime.toLocaleString() +
                                                      (entry.mtime.getTime() != entry.ctime.getTime() ? '\nModifié : ' + entry.mtime.toLocaleString() : '');

                                        if (tags.length)
                                            tooltip += '\n\nTags : ' + tags.map(tag => tag.label).join(', ');

                                        return html`
                                            <td class=${active && route.page.key == col.store ? 'saved active' : 'saved'} title=${tooltip}>
                                                <a href=${url}>${entry.mtime.toLocaleDateString()}</a>
                                                ${tags.map(tag => html` <span style=${'color: ' + tag.color + ';'}>⏺\uFE0E</span>`)}
                                            </td>
                                        `;
                                    } else {
                                        return html`<td class=${active && route.page.key == col.store ? 'missing active' : 'missing'}
                                                        title=${col.title}><a href=${url}>Afficher</a></td>`;
                                    }
                                })}
                                ${goupile.hasPermission('data_delete') ?
                                    html`<th><a @click=${UI.wrap(e => runDeleteRecordDialog(e, row.ulid))}>✕</a></th>` : ''}
                            </tr>
                        `;
                    })}
                    ${recording_new ? html`
                        <tr>
                            <td class="active missing">NA</td>
                            <td class="active missing">NA</td>
                            <td class="missing" colspan=${data_columns.length}><a @click=${e => togglePanels(null, 'view')}>Nouvel enregistrement</a></td>
                        </tr>
                    ` : ''}
                    ${!data_rows.length && !recording_new ? html`<tr><td colspan=${2 + data_columns.length}>Aucune ligne à afficher</td></tr>` : ''}
                </tbody>
            </table>

            ${goupile.hasPermission('data_export') ? html`
                <div class="ui_actions">
                    <button @click=${UI.wrap(e => exportRecords(app.stores.slice(1).map(store => store.key)))}>Exporter les données</button>
                </div>
            ` : ''}
        </div>
    `;
}

function toggleTagFilter(tag) {
    if (tag == null) {
        if (data_tags == null) {
            data_tags = new Set(app.tags.map(tag => tag.key));
        } else {
            data_tags = null;
        }
    } else if (data_tags != null) {
        if (!data_tags.delete(tag))
            data_tags.add(tag);
    }

     return go();
}

async function renderPage() {
    let buffer = code_buffers.get(route.page.filename);

    let model = new FormModel;
    let builder = new FormBuilder(form_state, model);
    let meta = new MetaModel;

    try {
        let func = code_builds.get(buffer.sha256);

        if (func == null)
            throw null;

        await func({
            app: app,
            form: builder,
            meta: new MetaInterface(form_data, meta),
            values: form_state.data
        });

        addAutomaticActions(builder, model);
        addAutomaticTags(model.variables);

        render(model.renderWidgets(), page_div);
        page_div.classList.remove('disabled');

        form_model = model;
        form_builder = builder;
        form_meta = meta;

        error_entries.page.close();
    } catch (err) {
        if (!page_div.children.length)
            render('Impossible de générer la page à cause d\'une erreur', page_div);
        page_div.classList.add('disabled');

        if (err != null)
            error_entries.page.error(err, profile.develop ? -1 : Log.defaultTimeout);
    }

    let show_menu = (profile.lock == null && (route.menu.chain.length > 2 || route.menu.chain[0].children.length > 1));
    let menu_is_wide = (show_menu && route.menu.chain[0].children.length > 3);

    // Quick access to page sections
    let page_sections = model.widgets.filter(intf => intf.options.anchor).map(intf => ({
        title: intf.label,
        anchor: intf.options.anchor
    }));

    return html`
        <div class="print" @scroll=${syncEditorScroll}}>
            <div id="ins_page">
                <div id="ins_menu">${show_menu ? Util.mapRange(1 - menu_is_wide, route.menu.chain.length,
                                                               idx => renderPageMenu(route.menu.chain[idx])) : ''}</div>

                <form id="ins_form" autocomplete="off" @submit=${e => e.preventDefault()}>
                    ${page_div}
                </form>

                <div id="ins_actions">
                    ${model.renderActions()}

                    ${page_sections.length > 1 ? html`
                        <h1>${route.page.title}</h1>
                        <ul>${page_sections.map(section => html`<li><a href=${'#' + section.anchor}>${section.title}</a></li>`)}</ul>
                    ` : ''}
                </div>
            </div>
            <div style="flex: 1;"></div>

            ${model.actions.length ? html`
                <nav class="ui_toolbar" id="ins_tasks" style="z-index: 999999;">
                    <div style="flex: 1;"></div>

                    ${model.actions.some(action => !action.options.always) ? html`
                        <div class="drop up right">
                            <button @click=${UI.deployMenu}>Actions</button>
                            <div>
                                ${model.actions.map(action => action.render())}
                            </div>
                        </div>
                        <hr/>
                    ` : ''}
                    ${Util.mapRange(0, model.actions.length, idx => {
                        let action = model.actions[model.actions.length - idx - 1];

                        if (action.label.match(/^\-+$/))
                            return '';
                        if (!action.options.always)
                            return '';

                        return action.render();
                    })}
                </nav>
            ` : ''}
        </div>
    `;
}

function addAutomaticActions(builder, model) {
    if (builder.hasErrors())
        builder.errorList();

    if (route.page.store != null) {
        let force = builder.justTriggered();

        let label = force ? '+Forcer l\'enregistrement' : '+Enregistrer';
        let color = force ? null : '#2d8261';

        builder.action(label, { disabled: !form_state.hasChanged(), color: color }, async () => {
            if (!force)
                form_builder.triggerErrors();
            await saveRecord();

            // Reload list
            data_threads = null;

            // Reload thread
            await loadRecord(form_thread.tid, null, route.page);
            route.tid = form_thread.tid;
            route.anchor = null;

            go();
        });

        if (form_state.hasChanged()) {
            builder.action('-');
            builder.action('Oublier', { color: '#db0a0a', always: form_entry.anchor >= 0 }, async e => {
                await UI.confirm(e, html`Souhaitez-vous réellement <b>annuler les modifications en cours</b> ?`,
                                       'Oublier', () => {});

                // Reload thread
                await loadRecord(route.tid, null, route.page);

                go();
            });
        }
    }
}

function addAutomaticTags(variables) {
    for (let intf of variables) {
        let tags = [];

        let note = form_data.getNote(intf.key.root, 'status', {});
        let status = note[intf.key.name] ?? {};

        if (status.locked) {
            tags.push('locked');
            intf.options.readonly = true;
        } else if (status.filling == 'check') {
            tags.push('check');
        } else if (status.filling == 'wait') {
            tags.push('wait');
        } else if (status.filling != null) {
            // Do nothing but skip following tags
        } else if (intf.missing && intf.options.mandatory) {
            if (form_entry.anchor >= 0 || intf.errors.length)
                tags.push('incomplete');
        } else if (intf.errors.length) {
            tags.push('error');
        }

        if (Array.isArray(intf.options.tags))
            tags.push(...intf.options.tags);

        intf.options.tags = app.tags.filter(tag => tags.includes(tag.key));
    }
}

function renderPageMenu(menu) {
    if (!menu.children.length)
        return '';

    return html`
        <h1>${menu.title}</h1>
        <ul>
            ${Util.map(menu.children, item => {
                let active = route.menu.chain.includes(item);
                let url = contextualizeURL(item.url, form_thread);

                return html`
                    <li><a class=${active ? 'active' : ''} href=${url}>
                        <div style="flex: 1;">${item.title}</div>
                    </a></li>
                `;
            })}
        </ul>
    `;
}

async function syncEditor() {
    if (editor_el == null) {
        if (typeof ace === 'undefined')
            await Net.loadScript(`${ENV.urls.static}ace/ace.js`);

        editor_el = document.createElement('div');
        editor_el.setAttribute('style', 'flex: 1;');
        editor_ace = ace.edit(editor_el);

        editor_ace.setShowPrintMargin(false);
        editor_ace.setFontSize(13);
        editor_ace.setBehavioursEnabled(false);
        editor_ace.setOptions({
            scrollPastEnd: 1
        });
    }

    let buffer = code_buffers.get(editor_filename);

    if (buffer == null) {
        await fetchCode(editor_filename);
        buffer = code_buffers.get(editor_filename);
    }

    if (buffer.session == null) {
        let session = new ace.EditSession('', 'ace/mode/javascript');

        session.setOption('useWorker', false);
        session.setUseWrapMode(true);
        session.doc.setValue(buffer.code);
        session.setUndoManager(new ace.UndoManager());
        session.on('change', e => handleFileChange(editor_filename));

        session.on('changeScrollTop', () => {
            if (UI.isPanelActive('view'))
                setTimeout(syncFormScroll, 0);
        });
        session.selection.on('changeSelection', () => {
            syncFormHighlight(true);
            ignore_editor_scroll = performance.now();
        });

        buffer.session = session;
    }

    if (editor_filename === 'main.js') {
        editor_ace.setTheme('ace/theme/monokai');
    } else {
        editor_ace.setTheme('ace/theme/merbivore_soft');
    }

    editor_ace.setSession(buffer.session);
}

function toggleEditorFile(e, filename) {
    editor_filename = filename;
    return togglePanels(true, null);
}

async function handleFileChange(filename) {
    if (ignore_editor_change)
        return;

    let db = await goupile.openLocalDB();

    let buffer = code_buffers.get(filename);
    let code = buffer.session.doc.getValue();
    let blob = new Blob([code]);
    let sha256 = await Sha256.async(blob);

    let key = `${profile.userid}/${filename}`;

    await db.saveWithKey('changes', key, {
        filename: filename,
        size: blob.size,
        sha256: sha256,
        blob: blob
    });

    buffer.code = code;
    buffer.sha256 = sha256;

    try {
        func = await buildScript(buffer.code, ['app', 'form', 'meta', 'values']);
        code_builds.set(buffer.sha256, func);
    } catch (err) {
        error_entries.page.error(err, profile.develop ? -1 : Log.defaultTimeout);
    }

    if (fs_timer != null)
        clearTimeout(fs_timer);
    fs_timer = setTimeout(uploadFsChanges, 2000);

    if (filename == 'main.js') {
        try {
            await runMainScript();
        } catch (err) {
            error_entries.app.error(err, -1);
        }
    }
    run();
}

async function uploadFsChanges() {
    await mutex.run(async () => {
        let progress = Log.progress('Envoi des modifications');

        try {
            let db = await goupile.openLocalDB();

            let range = IDBKeyRange.bound(profile.userid + '/',
                                          profile.userid + '`', false, true);
            let changes = await db.loadAll('changes', range);

            for (let file of changes) {
                let url = Util.pasteURL(`${ENV.urls.base}files/${file.filename}`, { sha256: file.sha256 });

                let response = await Net.fetch(url, {
                    method: 'PUT',
                    body: file.blob,
                    timeout: null
                });
                if (!response.ok && response.status !== 409) {
                    let err = await Net.readError(response);
                    throw new Error(err)
                }

                let key = `${profile.userid}/${file.filename}`;
                await db.delete('changes', key);
            }

            progress.close();
        } catch (err) {
            progress.close();
            Log.error(err);
        }

        if (fs_timer != null)
            clearTimeout(fs_timer);
        fs_timer = null;
    });
}

function syncFormScroll() {
    if (!UI.isPanelActive('editor') || !UI.isPanelActive('view'))
        return;
    if (performance.now() - ignore_editor_scroll < 500)
        return;
    if (!editor_ace.isFocused())
        return;

    try {
        let panel_el = document.querySelector('#ins_page').parentNode;
        let widget_els = panel_el.querySelectorAll('*[data-line]');

        let editor_line = editor_ace.getFirstVisibleRow() + 1;

        let prev_line;
        for (let i = 0; i < widget_els.length; i++) {
            let line = parseInt(widget_els[i].dataset.line, 10);

            if (line >= editor_line) {
                if (!i) {
                    ignore_page_scroll = performance.now();
                    panel_el.scrollTop = 0;
                } else if (i === widget_els.length - 1) {
                    let top = computeRelativeTop(panel_el, widget_els[i]);

                    ignore_page_scroll = performance.now();
                    panel_el.scrollTop = top;
                } else {
                    let top1 = computeRelativeTop(panel_el, widget_els[i - 1]);
                    let top2 = computeRelativeTop(panel_el, widget_els[i]);
                    let frac = (editor_line - prev_line) / (line - prev_line);

                    ignore_page_scroll = performance.now();
                    panel_el.scrollTop = top1 + frac * (top2 - top1);
                }

                break;
            }

            prev_line = line;
        }
    } catch (err) {
        // Meh, don't wreck the editor if for some reason we can't sync the
        // two views, this is not serious so just log it.
        console.log(err);
    }
}

function computeRelativeTop(parent, el) {
    let top = 0;
    while (el !== parent) {
        top += el.offsetTop;
        el = el.offsetParent;
    }
    return top;
}

function syncFormHighlight(scroll) {
    if (!UI.isPanelActive('view'))
        return;

    try {
        let panel_el = document.querySelector('#ins_page').parentNode;
        let widget_els = panel_el.querySelectorAll('*[data-line]');

        if (UI.isPanelActive('editor') && widget_els.length) {
            let selection = editor_ace.session.selection;
            let editor_lines = [
                selection.getRange().start.row + 1,
                selection.getRange().end.row + 1
            ];

            let highlight_first;
            let highlight_last;
            for (let i = 0;; i++) {
                let line = parseInt(widget_els[i].dataset.line, 10);

                if (line > editor_lines[0]) {
                    if (i > 0)
                        highlight_first = i - 1;
                    break;
                }

                if (i >= widget_els.length - 1) {
                    highlight_first = i;
                    break;
                }
            }
            if (highlight_first != null) {
                highlight_last = highlight_first;

                while (highlight_last < widget_els.length) {
                    let line = parseInt(widget_els[highlight_last].dataset.line, 10);
                    if (line > editor_lines[1])
                        break;
                    highlight_last++;
                }
                highlight_last--;
            }

            for (let i = 0; i < widget_els.length; i++)
                widget_els[i].classList.toggle('ins_highlight', i >= highlight_first && i <= highlight_last);

            // Make sure widget is in viewport
            if (scroll && highlight_first != null &&
                          highlight_last === highlight_first) {
                let el = widget_els[highlight_first];
                let rect = el.getBoundingClientRect();

                if (rect.top < 0) {
                    ignore_page_scroll = performance.now();
                    panel_el.scrollTop += rect.top - 50;
                } else if (rect.bottom >= window.innerHeight) {
                    ignore_page_scroll = performance.now();
                    panel_el.scrollTop += rect.bottom - window.innerHeight + 30;
                }
            }
        } else {
            for (let el of widget_els)
                el.classList.remove('ins_highlight');
        }
    } catch (err) {
        // Meh, don't wreck the editor if for some reason we can't sync the
        // two views, this is not serious so just log it.
        console.log(err);
    }
}

function syncEditorScroll() {
    if (!UI.isPanelActive('editor') || !UI.isPanelActive('view'))
        return;
    if (performance.now() - ignore_page_scroll < 500)
        return;

    try {
        let panel_el = document.querySelector('#ins_page').parentNode;
        let widget_els = panel_el.querySelectorAll('*[data-line]');

        let prev_top;
        let prev_line;
        for (let i = 0; i < widget_els.length; i++) {
            let el = widget_els[i];

            let top = el.getBoundingClientRect().top;
            let line = parseInt(el.dataset.line, 10);

            if (top >= 0) {
                if (!i) {
                    ignore_editor_scroll = performance.now();
                    editor_ace.renderer.scrollToLine(0);
                } else {
                    let frac = -prev_top / (top - prev_top);
                    let line2 = Math.floor(prev_line + frac * (line - prev_line));

                    ignore_editor_scroll = performance.now();
                    editor_ace.renderer.scrollToLine(line2);
                }

                break;
            }

            prev_top = top;
            prev_line = line;
        }
    } catch (err) {
        // Meh, don't wreck anything if for some reason we can't sync the
        // two views, this is not serious so just log it.
        console.log(err);
    }
}

async function runPublishDialog(e) {
    await uploadFsChanges();

    let publisher = new InstancePublisher;
    await publisher.runDialog(e);

    run();
}

async function go(e, url = null, options = {}) {
    await mutex.run(async () => {
        options = Object.assign({ push_history: true }, options);

        let new_route = Object.assign({}, route);
        let explicit_panels = false;

        if (url != null) {
            if (!(url instanceof URL))
                url = new URL(url, window.location.href);
            if (url.pathname === ENV.urls.instance)
                url = new URL(app.homepage.url, window.location.href);
            goupile.setCurrentHash(url.hash);

            if (!url.pathname.endsWith('/'))
                url.pathname += '/';

            // Goodbye!
            if (!url.pathname.startsWith(ENV.urls.instance)) {
                if (hasUnsavedData())
                    await goupile.confirmDangerousAction(e);

                window.onbeforeunload = null;
                window.location.href = url.href;

                return;
            }

            let path = url.pathname.substr(ENV.urls.instance.length);
            let [key, what] = path.split('/').map(str => str.trim());

            // Find page information
            new_route.page = app.pages.find(page => page.key == key);
            if (new_route.page == null) {
                Log.error(`La page '${key}' n'existe pas`);
                new_route.page = app.homepage;
            }
            new_route.menu = new_route.page.menu;

            let [tid, anchor] = what ? what.split('@') : [null, null];

            // Deal with TID and anchor
            if (tid != new_route.tid) {
                new_route.tid = tid || null;
                new_route.anchor = null;
            }
            if (anchor != null) {
                anchor = anchor.trim();

                if (anchor.match(/^[0-9]+$/)) {
                    new_route.anchor = parseInt(anchor, 10);
                } else if (!anchor.length) {
                    new_route.anchor = null;
                } else {
                    Log.error('L\'indicateur de version n\'est pas un nombre');
                    new_route.anchor = null;
                }
            }

            // Restore explicit panels (if any)
            let panels = url.searchParams.get('p');

            if (panels) {
                panels = panels.split('|');
                panels = panels.filter(key => app.panels.hasOwnProperty(key) || key == 'view');

                if (panels.length) {
                    UI.setPanels(panels);
                    explicit_panels = true;
                }
            }
        }

        let context_change = (new_route.tid != route.tid ||
                              new_route.anchor != route.anchor ||
                              new_route.page != route.page);

        // Warn about data loss before loading new data
        if (context_change) {
            if (hasUnsavedData()) {
                try {
                    await UI.dialog(e, 'Enregistrer (confirmation)', {}, (d, resolve, reject) => {
                        d.output(html`Si vous continuez, vos <b>modifications seront enregistrées</b>.`);

                        d.enumRadio('save', 'Que souhaitez-vous faire avant de continuer ?', [
                            [true, "Enregistrer mes modifications"],
                            [false, "Oublier mes modifications"]
                        ], { value: true, untoggle: false });

                        if (d.values.save) {
                            d.action('Enregistrer', {}, async e => {
                                try {
                                    form_builder.triggerErrors();
                                    await mutex.chain(saveRecord);
                                } catch (err) {
                                    reject(err);
                                }

                                resolve();
                            });
                        } else {
                            d.action('Oublier', {}, resolve);
                        }
                    });
                } catch (err) {
                    if (err != null)
                        Log.error(err);

                    // If we're popping state, this will fuck up navigation history but we can't
                    // refuse popstate events. History mess is better than data loss.
                    await mutex.chain(run);
                    return;
                }
            }

            await loadRecord(new_route.tid, new_route.anchor, new_route.page);
        }

        // Show form automatically?
        if (url != null && !UI.isPanelActive('view') && !explicit_panels) {
            let show_view = true;

            if (UI.isPanelActive('data') && !form_thread.saved && route.page == null)
                show_view = false;

            if (show_view) {
                UI.togglePanel('data', false);
                UI.togglePanel('view', true);
            }
        }

        // We're set!
        route = new_route;

        await mutex.chain(() => run(options.push_history));
    });
}

function contextualizeURL(url, thread) {
    if (thread != null && thread.saved) {
        url += `/${thread.tid}`;

        if (thread == form_thread && route.anchor != null)
            url += `@${route.anchor}`;
    }

    return url;
}

async function run(push_history = true) {
    await mutex.run(async () => {
        let filename = route.page.filename;

        // Fetch and build page code for page panel
        {
            let buffer = await fetchCode(filename);
            let func = code_builds.get(buffer.sha256);

            if (func == null) {
                try {
                    func = await buildScript(buffer.code, ['app', 'form', 'meta', 'values']);
                    code_builds.set(buffer.sha256, func);
                } catch (err) {
                    if (!profile.develop)
                        throw err;

                    error_entries.page.error(err, -1);
                }
            }
        }

        // Sync editor (if needed)
        if (UI.isPanelActive('editor')) {
            if (editor_filename !== 'main.js')
                editor_filename = filename;

            await syncEditor();
        }

        // Load data rows (if needed)
        if (UI.isPanelActive('data')) {
            let stores = app.stores.slice();
            let store0 = stores.shift();

            if (data_threads == null) {
                let threads = await Net.get(`${ENV.urls.instance}api/records/list`);

                data_threads = threads.map(thread => {
                    let sequence = null;
                    let min_ctime = Number.MAX_SAFE_INTEGER;
                    let max_mtime = 0;
                    let tags = new Set;

                    for (let store in thread.entries) {
                        let entry = thread.entries[store];

                        if (sequence == null)
                            sequence = entry.sequence;

                        for (let tag of entry.tags)
                            tags.add(tag);

                        min_ctime = Math.min(min_ctime, entry.ctime);
                        max_mtime = Math.max(max_mtime, entry.mtime);

                        entry.ctime = new Date(entry.ctime);
                        entry.mtime = new Date(entry.mtime);
                    }

                    return {
                        tid: thread.tid,
                        sequence: sequence,
                        ctime: new Date(min_ctime),
                        mtime: new Date(max_mtime),
                        entries: thread.entries,
                        tags: Array.from(tags)
                    };
                });
            }

            data_rows = data_threads;
            if (data_tags != null)
                data_rows = data_rows.filter(thread => thread.tags.some(tag => data_tags.has(tag)));

            data_columns = stores.map(store => {
                let col = {
                    store: store.key,
                    title: store.title,
                    url: store.url,
                    count: data_rows.reduce((acc, row) => acc + (row.entries[store.key] != null), 0)
                };

                return col;
            });
        }

        // Update URL and title
        {
            let url = contextualizeURL(route.page.url, form_thread);
            let panels = UI.getPanels().join('|');

            if (!profile.develop && panels == 'view')
                panels = null;

            url = Util.pasteURL(url, { p: panels });
            goupile.syncHistory(url, push_history);

            document.title = `${route.page.title} — ${ENV.title}`;
        }

        // Don't mess with the editor when render accidently triggers a scroll event!
        ignore_page_scroll = performance.now();
        UI.draw();
    });
}

async function fetchCode(filename) {
    // Anything in cache
    {
        let buffer = code_buffers.get(filename);

        if (buffer != null)
            return buffer;
    }

    // Try locally saved files
    if (profile.develop) {
        let db = await goupile.openLocalDB();

        let key = `${profile.userid}/${filename}`;
        let file = await db.load('changes', key);

        if (file != null) {
            if (file.blob != null) {
                let code = await file.blob.text();
                return updateBuffer(filename, code);
            } else {
                return updateBuffer(filename, '');
            }
        }
    }

    // The server is our last hope
    {
        let url = `${ENV.urls.files}${filename}`;
        let response = await Net.fetch(url);

        if (response.ok) {
            let code = await response.text();
            return updateBuffer(filename, code);
        } else if (response.status != 404) {
            let err = await Net.readError(response);
            throw new Error(err);
        }
    }

    // Got nothing
    return updateBuffer(filename, '');
}

function updateBuffer(filename, code, version = null) {
    let buffer = code_buffers.get(filename);

    let sha256 = Sha256(code);

    if (buffer == null) {
        buffer = {
            code: code,
            sha256: null,
            original_sha256: sha256,
            session: null,
            version: null
        };
        code_buffers.set(filename, buffer);
    } else if (buffer.session != null && sha256 !== buffer.sha256) {
        try {
            ignore_editor_change = true;
            buffer.session.doc.setValue(code);
        } finally {
            ignore_editor_change = false;
        }
    }

    buffer.code = code;
    buffer.sha256 = sha256;
    buffer.version = version || 0;

    return buffer;
}

function fileHasChanged(filename) {
    let buffer = code_buffers.get(filename);

    if (buffer != null) {
        let changed = (buffer.sha256 !== buffer.original_sha256);
        return changed;
    } else {
        return false;
    }
}

function getFillingStatuses(intf) {
    let statuses = [];

    statuses.push(['wait', 'En attente']);
    statuses.push(['check', 'À vérifier']);
    if (intf.missing) {
        statuses.push(
            ['na', 'Non applicable'],
            ['nd', 'Non disponible']
        );
    } else {
        statuses.push(['complete', 'Complet']);
    }

    return statuses;
}

async function buildScript(code, variables) {
    // JS is always classy
    let AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

    let base = {
        goupile: goupile,
        profile: profile,
        html: html,
        svg: svg,
        LocalDate: LocalDate,
        LocalTime: LocalTime,

        dates: LocalDate, // Deprecated
        times: LocalTime // Deprecated
    };

    variables = [...Object.keys(base), ...variables];

    try {
        let func = new AsyncFunction(variables, code);

        return async api => {
            api = Object.assign({}, base, api);

            try {
                let values = variables.map(key => api[key]);
                await func(...values);
            } catch (err) {
                throwScriptError(err);
            }
        };
    } catch (err) {
        throwScriptError(err);
    }
}

function throwScriptError(err) {
    let line = Util.parseEvalErrorLine(err);
    let msg = `Erreur de script\n${line != null ? `Ligne ${line} : ` : ''}${err.message}`;

    throw new Error(msg);
}

async function loadRecord(tid, anchor, page) {
    let new_thread = null;
    let new_entry = null;
    let new_data = null;
    let new_state = null;

    // Load or create thread
    if (tid != null) {
        let url = Util.pasteURL(`${ENV.urls.instance}api/records/get`, {
            tid: tid,
            anchor: anchor
        });

        new_thread = await Net.get(url);
    } else {
        new_thread = {
            tid: Util.makeULID(),
            saved: false,
            entries: {}
        };
    }

    // Initialize entry data
    if (page.store != null) {
        new_entry = new_thread.entries[page.store];

        if (new_entry == null) {
            let now = (new Date).valueOf();

            new_entry = {
                store: page.store,
                eid: Util.makeULID(),
                deleted: false,
                anchor: -1,
                ctime: now,
                mtime: now,
                sequence: null,
                tags: []
            };

            new_thread.entries[page.store] = new_entry;
        }

        new_data = new MagicData(new_entry.data, new_entry.meta);
        new_state = new FormState(new_data);
    } else {
        new_data = new MagicData;
        new_state = new FormState(new_data);
    }

    // Copy UI state if needed
    if (form_state != null && page == route.page) {
        new_state.state_tabs = form_state.state_tabs;
        new_state.state_sections = form_state.state_sections;

        /* XXX if (new_record.saved && new_record.ulid == form_record.ulid)
            new_state.take_delayed = form_state.take_delayed; */
    }

    // Run after each change
    new_state.changeHandler = async () => {
        await run();

        // Highlight might need to change (conditions, etc.)
        if (UI.isPanelActive('editor'))
            syncFormHighlight(false);
    };

    // Handle annotation form
    new_state.annotateHandler = (e, intf) => {
        return UI.dialog(e, intf.label, {}, (d, resolve, reject) => {
            let note = form_data.getNote(intf.key.root, 'status', {});
            let status = note[intf.key.name];

            if (status == null) {
                status = {};
                note[intf.key.name] = status;
            }

            let locked = d.values.hasOwnProperty('locked') ? d.values.locked : status.locked;
            let statuses = getFillingStatuses(intf);

            d.enumRadio('filling', 'Statut actuel', statuses, { value: status.filling, disabled: locked });
            d.textArea('comment', 'Commentaire', { rows: 4, value: status.comment, disabled: locked });

            if (goupile.hasPermission('data_audit'))
                d.binary('locked', 'Validation finale', { value: status.locked });

            d.action('Appliquer', { disabled: !d.isValid() }, async () => {
                status.filling = d.values.filling;
                status.comment = d.values.comment;
                status.locked = d.values.locked;

                form_state.markChange();

                resolve();
            });
        });
    };

    form_thread = new_thread;
    form_entry = new_entry;
    form_data = new_data;
    form_state = new_state;

    form_model = null;
    form_builder = null;
    form_meta = null;
}

async function saveRecord() {
    await mutex.run(async () => {
        // Gather global list of tags for this record entry
        let tags = new Set;
        for (let intf of form_model.variables) {
            if (Array.isArray(intf.options.tags)) {
                for (let tag of intf.options.tags)
                    tags.add(tag.key);
            }
        }
        tags = Array.from(tags);

        // Transform undefined into null
        let data = JSON.parse(JSON.stringify(form_data.raw, (k, v) => v != null ? v : null));

        await Net.post(ENV.urls.instance + 'api/records/save', {
            tid: form_thread.tid,
            fragment: {
                fs: ENV.version,
                eid: form_entry.eid,
                store: form_entry.store,
                anchor: form_entry.anchor,
                mtime: (new Date).valueOf(),
                data: data,
                meta: form_data.exportNotes(),
                tags: tags,
                constraints: form_meta.constraints
            }
        });
    });
}

export {
    init,
    hasUnsavedData,
    runTasks,
    go
}
