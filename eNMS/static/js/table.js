/*
global
tableProperties: false
*/

import {
  call,
  configureNamespace,
  copyToClipboard,
  createTooltip,
  createTooltips,
  downloadFile,
  notify,
  openPanel,
  serializeForm,
  userIsActive,
} from "./base.js";
import { loadServiceTypes } from "./automation.js";

export let tables = {};
export let tableInstances = {};
export const models = {};
let waitForSearch = false;

$.fn.dataTable.ext.errMode = "none";

export class Table {
  constructor(id, constraints, relation) {
    let self = this;
    this.relation = relation;
    if (relation) this.relationString = JSON.stringify(relation).replace(/"/g, "'");
    this.columns = tableProperties[this.type];
    this.constraints = constraints;
    let visibleColumns = localStorage.getItem(`${this.type}_table`);
    if (visibleColumns) visibleColumns = visibleColumns.split(",");
    this.columns.forEach((column) => {
      if (visibleColumns) column.visible = visibleColumns.includes(column.data);
      column.name = column.data;
    });
    this.id = `${this.type}${id ? `-${id}` : ""}`;
    tableInstances[this.id] = this;
    // eslint-disable-next-line new-cap
    this.table = $(`#table-${this.id}`).DataTable({
      serverSide: true,
      orderCellsTop: true,
      autoWidth: false,
      scrollX: true,
      drawCallback: function () {
        $(".paginate_button > a").on("focus", function () {
          $(this).blur();
        });
        createTooltips();
      },
      sDom: "tilp",
      columns: this.columns,
      columnDefs: [{ className: "dt-center", targets: "_all" }],
      initComplete: function () {
        this.api()
          .columns()
          .every(function (index) {
            const data = self.columns[index];
            let element;
            const elementId = `${self.type}_filtering-${data.data}`;
            if (data.search == "text") {
              element = `
              <div class="input-group table-search" style="width:100%">
                <input
                  id="${elementId}"
                  name="${data.data}"
                  type="text"
                  placeholder="&#xF002;"
                  class="form-control search-input-${self.id}"
                  style="font-family:Arial, FontAwesome;
                  height: 30px; margin-top: 5px"
                >
                <span class="input-group-btn" style="width: 10px">
                  <button
                    id="${elementId}-search"
                    class="btn btn-default pull-right"
                    type="button"
                    style="height: 30px; margin-top: 5px">
                      <span
                        class="glyphicon glyphicon-center glyphicon-menu-down"
                        aria-hidden="true"
                        style="font-size: 10px">
                      </span>
                  </button>
                </span>
              </div>`;
            } else if (data.search == "bool") {
              element = `
                <select
                  id="${elementId}"
                  name="${data.data}"
                  class="form-control search-list-${self.id}"
                  style="width: 100%; height: 30px; margin-top: 5px"
                >
                  <option value="">Any</option>
                  <option value="bool-true">
                    ${data?.search_labels?.true || "True"}
                  </option>
                  <option value="bool-false">
                    ${data?.search_labels?.false || "False"}
                  </option>
                </select>`;
            }
            $(element)
              .appendTo($(this.header()))
              .on("keyup change", function () {
                if (waitForSearch) return;
                waitForSearch = true;
                setTimeout(function () {
                  self.table.page(0).ajax.reload(null, false);
                  waitForSearch = false;
                }, 500);
              })
              .on("click", function (e) {
                e.stopPropagation();
              });
          });
        $(`#controls-${self.id}`).append(self.controls);
        self.postProcessing();
      },
      ajax: {
        url: `/filtering/${this.modelFiltering || this.type}`,
        type: "POST",
        contentType: "application/json",
        data: (d) => {
          Object.assign(d, {
            form: serializeForm(`#search-form-${this.id}`),
            constraints: constraints,
            columns: this.columns,
            type: this.type,
            export: self.csvExport,
            clipboard: self.copyClipboard,
            prefilter: self.id == "run",
          });
          Object.assign(d, self.filteringData);
          return JSON.stringify(d);
        },
        dataSrc: function (result) {
          if (result.error) {
            notify(result.error, "error", 5);
            return [];
          }
          if (self.csvExport) {
            self.exportTable(result.full_result);
            self.csvExport = false;
          }
          if (self.copyClipboard) {
            copyToClipboard({ text: result.full_result, includeText: false });
            self.copyClipboard = false;
          }
          return result.data.map((instance) =>
            self.addRow({ properties: instance, tableId: self.id })
          );
        },
      },
    });
    $(window).resize(this.table.columns.adjust);
    $(`[name=table-${this.id}_length]`).selectpicker("refresh");
    if (["changelog", "run", "result"].includes(this.type)) {
      this.table.order([0, "desc"]).draw();
    }
    if (["run", "service", "task", "workflow"].includes(this.type)) {
      refreshTablePeriodically(this.id, 3000, true);
    }
  }

  exportTable(result) {
    const visibleColumns = this.columns
      .filter((column) => {
        const isExportable = typeof column.export === "undefined" || column.export;
        const visibleColumn = this.table.column(`${column.name}:name`).visible();
        return isExportable && visibleColumn;
      })
      .map((column) => column.name);
    result = result.map((instance) => {
      Object.keys(instance).forEach((key) => {
        if (!visibleColumns.includes(key)) delete instance[key];
      });
      return visibleColumns.map((column) => `"${instance[column]}"`);
    });
    downloadFile(
      this.type,
      [visibleColumns, ...result].map((e) => e.join(",")).join("\n"),
      "csv"
    );
  }

  postProcessing() {
    let self = this;
    if ($(`#advanced-search-${this.type}`).length) {
      createTooltip({
        autoshow: true,
        persistent: true,
        name: `${this.type}_relation_filtering`,
        target: `#advanced-search-${this.type}`,
        container: `#controls-${this.type}`,
        position: {
          my: "center-top",
          at: "center-bottom",
          offsetY: 18,
        },
        url: `../${this.type}_relation_filtering_form`,
        title: "Relationship-based Filtering",
      });
    }
    this.createfilteringTooltips();
    createTooltips();
    const visibleColumns = localStorage.getItem(`${this.type}_table`);
    this.columns.forEach((column) => {
      const visible = visibleColumns
        ? visibleColumns.split(",").includes(column.name)
        : "visible" in column
        ? column.visible
        : true;
      $(`#column-display-${this.id}`).append(
        new Option(column.title || column.data, column.data, visible, visible)
      );
    });
    $(`#column-display-${this.id}`).selectpicker("refresh");
    $(`#column-display-${this.id}`).on("change", function () {
      self.columns.forEach((col) => {
        self.table.column(`${col.name}:name`).visible($(this).val().includes(col.data));
      });
      self.table.ajax.reload(null, false);
      self.createfilteringTooltips();
      localStorage.setItem(`${self.type}_table`, $(this).val());
    });
    self.table.columns.adjust();
  }

  createfilteringTooltips() {
    this.columns.forEach((column) => {
      if (column.search != "text") return;
      const elementId = `${this.type}_filtering-${column.data}`;
      createTooltip({
        persistent: true,
        name: elementId,
        target: `#${elementId}-search`,
        container: `#tooltip-overlay`,
        position: {
          my: "center-top",
          at: "center-bottom",
        },
        content: `
        <div class="modal-body">
          <select
            id="${column.data}_filter"
            name="${column.data}_filter"
            class="form-control search-select-${this.id}"
            style="width: 100%; height: 30px; margin-top: 15px"
          >
            <option value="inclusion">Inclusion</option>
            <option value="equality">Equality</option>
            <option value="regex">Regular Expression</option>
          </select>
        </div>`,
      });
    });
  }

  columnDisplay() {
    return `
      <button
        style="background:transparent; border:none; 
        color:transparent; width: 200px;"
        type="button"
      >
        <select multiple
          id="column-display-${this.id}"
          title="Columns"
          class="form-control"
          data-size="20"
          data-actions-box="true"
          data-selected-text-format="static"
        ></select>
      </button>`;
  }

  createNewButton() {
    const onClick = this.relation
      ? `eNMS.base.showAddInstancePanel(
          '${this.id}', '${this.type}', ${this.relationString}
        )`
      : this.type == "service"
      ? `eNMS.automation.openServicePanel()`
      : `eNMS.base.showInstancePanel('${this.type}')`;
    return `
      <button
        class="btn btn-primary"
        onclick="${onClick}"
        data-tooltip="${this.relation ? "Add" : "New"}"
        type="button"
      >
        <span class="glyphicon glyphicon-plus"></span>
      </button>`;
  }

  exportTableButton() {
    return `
      <button
        class="btn btn-primary"
        onclick="eNMS.table.exportTable('${this.id}')"
        data-tooltip="Export as .CSV"
        type="button"
      >
        <span class="glyphicon glyphicon-upload"></span>
      </button>`;
  }

  searchTableButton() {
    return `
      <button
        id="advanced-search-${this.type}"
        class="btn btn-info"
        data-tooltip="Advanced Search"
        type="button"
      >
        <span class="glyphicon glyphicon-search"></span>
      </button>`;
  }

  clearSearchButton() {
    return `
      <button
        class="btn btn-info"
        onclick="eNMS.table.clearSearch('${this.id}', true)"
        data-tooltip="Clear Search"
        type="button"
      >
      <span class="glyphicon glyphicon-remove"></span>
    </button>`;
  }

  refreshTableButton() {
    return `
      <button
        class="btn btn-info"
        onclick="eNMS.table.refreshTable('${this.id}', true)"
        data-tooltip="Refresh"
        type="button"
      >
        <span class="glyphicon glyphicon-refresh"></span>
      </button>`;
  }

  copyTableButton() {
    return `
      <button
        class="btn btn-info"
        onclick="eNMS.table.copySelectionToClipboard('${this.id}')"
        data-tooltip="Copy Selection to Clipboard"
        type="button"
      >
      <span class="glyphicon glyphicon-pencil"></span>
    </button>`;
  }

  bulkEditButton() {
    const panelType = this.modelFiltering || this.type;
    const showPanelFunction =
      panelType == "service"
        ? "automation.openServicePanel(true)"
        : `base.showInstancePanel('${panelType}', null, 'bulk', '${this.id}')`;
    return `
      <button
        class="btn btn-primary"
        onclick="eNMS.${showPanelFunction}"
        data-tooltip="Bulk Edit"
        type="button"
      >
        <span class="glyphicon glyphicon-edit"></span>
      </button>`;
  }

  bulkDeletionButton() {
    const type = this.modelFiltering || this.type;
    const onClick = this.relation
      ? `eNMS.table.bulkRemoval('${this.id}', '${type}', ${this.relationString})`
      : `eNMS.table.showBulkDeletionPanel('${this.id}', '${type}')`;
    return `
      <button
        class="btn btn-danger"
        onclick="${onClick}"
        data-tooltip="Bulk Deletion"
        type="button"
      >
        <span class="glyphicon glyphicon-${this.relation ? "remove" : "trash"}"></span>
      </button>`;
  }

  deleteInstanceButton(row) {
    const onClick = this.relation
      ? `eNMS.base.removeInstance(
          '${this.id}', ${row.instance}, ${this.relationString}
        )`
      : `eNMS.base.showDeletionPanel(${row.instance})`;
    return `
      <li>
        <button type="button" class="btn btn-sm btn-danger"
        onclick="${onClick}" data-tooltip="Delete"><span class="glyphicon
        glyphicon-${this.relation ? "remove" : "trash"}"></span></button>
      </li>`;
  }

  addRow({ properties, tableId, derivedProperties }) {
    let row = { tableId: tableId, ...properties };
    row.instanceProperties = {
      id: row.id,
      name: row.dbName || row.name,
      type: row.type,
    };
    if (derivedProperties) {
      derivedProperties.forEach((property) => {
        row.instanceProperties[property] = row[property];
      });
    }
    row.instance = JSON.stringify(row.instanceProperties).replace(/"/g, "'");
    if (this.buttons) row.buttons = this.buttons(row);
    return row;
  }
}

tables.device = class DeviceTable extends Table {
  addRow(kwargs) {
    let row = super.addRow({
      derivedProperties: ["last_runtime"],
      ...kwargs,
    });
    for (const model of ["service", "task", "pool"]) {
      row[`${model}s`] = `<b><a href="#" onclick="eNMS.table.displayRelationTable(
        '${model}', ${row.instance}, {from: 'devices', to: '${model}s'})">
        ${model.charAt(0).toUpperCase() + model.slice(1)}s</a></b>`;
    }
    return row;
  }

  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.searchTableButton(),
      this.clearSearchButton(),
      this.copyTableButton(),
      this.createNewButton(),
      this.bulkEditButton(),
      this.exportTableButton(),
      ` <button
        type="button"
        class="btn btn-success"
        onclick="eNMS.automation.showRunServicePanel(
          {tableId: '${this.id}', type: '${this.type}'}
        )"
        data-tooltip="Run service on all devices in table"
      >
        <span class="glyphicon glyphicon-play"></span>
      </button>`,
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return `
      <ul class="pagination pagination-lg" style="margin: 0px; width: 270px">
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.inventory.showDeviceData(${row.instance})"
          data-tooltip="Network Data"
            ><span class="glyphicon glyphicon-cog"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.inventory.showDeviceResultsPanel(${row.instance})"
          data-tooltip="Results"
            ><span class="glyphicon glyphicon-list-alt"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-dark"
          onclick="eNMS.inventory.showConnectionPanel(${row.instance})"
          data-tooltip="Connection"
            ><span class="glyphicon glyphicon-console"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('device', '${
            row.id
          }')" data-tooltip="Edit"
            ><span class="glyphicon glyphicon-edit"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('device', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate"
            ><span class="glyphicon glyphicon-duplicate"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-success"
          onclick="eNMS.automation.showRunServicePanel({instance: ${row.instance}})"
          data-tooltip="Run Service"><span class="glyphicon glyphicon-play">
          </span></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>`;
  }
};

tables.configuration = class ConfigurationTable extends Table {
  addRow(kwargs) {
    let row = super.addRow({
      derivedProperties: ["last_runtime"],
      ...kwargs,
    });
    const failureBtn = `<button type="button" class="btn btn-sm btn-danger">`;
    const successBtn = `<button type="button" class="btn btn-sm btn-success">`;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "string") continue;
      if (value.toLowerCase() == "failure") row[key] = `${failureBtn}Failure</button>`;
      if (value.toLowerCase() == "success") row[key] = `${successBtn}Success</button>`;
    }
    return row;
  }

  get modelFiltering() {
    return "device";
  }

  postProcessing(...args) {
    super.postProcessing(...args);
    $("#slider")
      .bootstrapSlider({
        value: 0,
        ticks: [...Array(6).keys()],
        formatter: (value) => `Lines of context: ${value}`,
        tooltip: "always",
      })
      .on("change", function () {
        refreshTable("configuration");
      });
  }

  get controls() {
    return [
      this.columnDisplay(),
      `<input
        name="context-lines"
        id="slider"
        class="slider"
        style="width: 200px"
      >`,
      this.refreshTableButton(),
      this.clearSearchButton(),
      this.copyTableButton(),
      this.bulkEditButton(),
      this.exportTableButton(),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return `
      <ul class="pagination pagination-lg" style="margin: 0px">
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.inventory.showDeviceData(${row.instance})"
          data-tooltip="Network Data"
            ><span class="glyphicon glyphicon-cog"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.inventory.showGitHistory(${row.instance})"
          data-tooltip="Historic"
            ><span class="glyphicon glyphicon-adjust"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('device', '${row.id}')"
          data-tooltip="Edit"><span class="glyphicon glyphicon-edit">
          </span></button>
        </li>
      </ul>`;
  }
};

tables.link = class LinkTable extends Table {
  addRow(properties) {
    let row = super.addRow(properties);
    row.pools = `<b><a href="#" onclick="eNMS.table.displayRelationTable(
      'pool', ${row.instance}, {from: 'links', to: 'pools'})">
      Pools</a></b>`;
    return row;
  }

  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.searchTableButton(),
      this.clearSearchButton(),
      this.copyTableButton(),
      this.createNewButton(),
      this.bulkEditButton(),
      this.exportTableButton(),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return `
      <ul class="pagination pagination-lg" style="margin: 0px; width: 120px">
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('link', '${row.id}')" data-tooltip="Edit"
            ><span class="glyphicon glyphicon-edit"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('link', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate"
            ><span class="glyphicon glyphicon-duplicate"></span
          ></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>`;
  }
};

tables.pool = class PoolTable extends Table {
  addRow(properties) {
    let row = super.addRow(properties);
    row.objectNumber = "";
    for (const model of ["device", "link", "service", "user"]) {
      row.objectNumber += `${row[`${model}_number`]} ${model}s`;
      if (model !== "user") row.objectNumber += " - ";
      row[`${model}s`] = `<b><a href="#" onclick="eNMS.table.displayRelationTable(
        '${model}', ${row.instance}, {from: 'pools', to: '${model}s'})">
        ${model.charAt(0).toUpperCase() + model.slice(1)}s</a></b>`;
    }
    return row;
  }

  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.searchTableButton(),
      this.clearSearchButton(),
      this.copyTableButton(),
      this.createNewButton(),
      this.exportTableButton(),
      ` <button
        class="btn btn-primary"
        onclick="eNMS.inventory.updatePools()"
        data-tooltip="Update all pools"
        type="button"
      >
        <span class="glyphicon glyphicon-flash"></span>
      </button>`,
      ` <button
        type="button"
        class="btn btn-success"
        onclick="eNMS.automation.showRunServicePanel(
          {tableId: '${this.id}', type: '${this.type}'}
        )"
        data-tooltip="Run service on all pools in table"
      >
        <span class="glyphicon glyphicon-play"></span>
      </button>`,
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return `
      <ul class="pagination pagination-lg" style="margin: 0px; width: 200px">
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.inventory.updatePools('${row.id}')"
          data-tooltip="Update"><span class="glyphicon glyphicon-refresh">
          </span></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('pool', '${row.id}')" data-tooltip="Edit"
            ><span class="glyphicon glyphicon-edit"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('pool', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate"
            ><span class="glyphicon glyphicon-duplicate"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-success"
          onclick="eNMS.automation.showRunServicePanel({instance: ${row.instance}})"
          data-tooltip="Run Service"><span class="glyphicon glyphicon-play">
          </span></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>
    `;
  }
};

tables.service = class ServiceTable extends Table {
  addRow(kwargs) {
    let row = super.addRow(kwargs);
    row.name =
      row.type === "workflow"
        ? `<b><a href="#" onclick="eNMS.workflow.filterWorkflowTable(
      '${this.id}', ${row.id})">${row.scoped_name}</a></b>`
        : $("#parent-filtering").val() == "true"
        ? row.scoped_name
        : row.name;
    for (const model of ["device", "pool"]) {
      row[`${model}s`] = `<b><a href="#" onclick="eNMS.table.displayRelationTable(
        '${model}', ${
        row.instance
      }, {from: 'target_services', to: 'target_${model}s'})">
        ${model.charAt(0).toUpperCase() + model.slice(1)}s</a></b>`;
    }
    return row;
  }

  get controls() {
    return [
      this.columnDisplay(),
      `
      <input type="hidden" id="workflow-filtering" name="workflow-filtering">
      <button
        style="background:transparent; border:none; 
        color:transparent; width: 300px;"
        type="button"
      >
        <select
          id="parent-filtering"
          name="parent-filtering"
          class="form-control"
        >
          <option value="true">Display services hierarchically</option>
          <option value="false">Display all services</option>
        </select>
      </button>
      </input>
      <button
        class="btn btn-info"
        onclick="eNMS.table.refreshTable('service', true)"
        data-tooltip="Refresh"
        type="button"
      >
        <span class="glyphicon glyphicon-refresh"></span>
      </button>`,
      this.searchTableButton(),
      this.clearSearchButton(),
      this.copyTableButton(),
      `
      <a
        id="left-arrow"
        class="btn btn-info disabled"
        onclick="action['Backward']()"
        type="button"
      >
        <span class="glyphicon glyphicon-chevron-left"></span>
      </a>
      <a
        id="right-arrow"
        class="btn btn-info disabled"
        onclick="action['Forward']()"
        type="button"
      >
        <span class="glyphicon glyphicon-chevron-right"></span>
      </a>`,
      this.createNewButton(),
      `
      <button
        style="background:transparent; border:none; 
        color:transparent; width: 200px;"
        type="button"
      >
        <select id="service-type" class="form-control"></select>
      </button>`,
      `<button
        class="btn btn-primary"
        onclick="eNMS.automation.showImportServicePanel()"
        data-tooltip="Import Service"
        type="button"
      >
        <span class="glyphicon glyphicon-circle-arrow-down"></span>
      </button>`,
      this.bulkEditButton(),
      this.exportTableButton(),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    let runtimeArg = "";
    if (row.type != "workflow") runtimeArg = ", null, 'result'";
    return `
      <ul class="pagination pagination-lg" style="margin: 0px; width: 270px">
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.automation.showRuntimePanel('logs', ${row.instance})"
          data-tooltip="Logs">
            <span class="glyphicon glyphicon-list"></span>
          </button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.automation.showRuntimePanel('results', ${row.instance}
          ${runtimeArg})" data-tooltip="Results">
            <span class="glyphicon glyphicon-list-alt"></span>
          </button>
        </li>
        <li>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            onclick="eNMS.base.showInstancePanel('${row.type}', '${row.id}')"
            data-tooltip="Edit"
          ><span class="glyphicon glyphicon-edit"></span></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="location.href='/export_service/${row.id}'" data-tooltip="Export"
            ><span class="glyphicon glyphicon-upload"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-success"
          onclick="eNMS.automation.normalRun('${row.id}')" data-tooltip="Run"
            ><span class="glyphicon glyphicon-play"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-success"
          onclick="eNMS.base.showInstancePanel('${row.type}', '${row.id}', 'run')"
          data-tooltip="Parameterized Run"
            ><span class="glyphicon glyphicon-play-circle"></span
          ></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>
    `;
  }

  postProcessing(...args) {
    let self = this;
    super.postProcessing(...args);
    loadServiceTypes();
    $("#parent-filtering")
      .selectpicker()
      .on("change", function () {
        self.table.page(0).ajax.reload(null, false);
      });
  }
};

tables.run = class RunTable extends Table {
  addRow(kwargs) {
    let row = super.addRow(kwargs);
    row.service = JSON.stringify(row.service_properties).replace(/"/g, "'");
    row.buttons = this.buttons(row);
    return row;
  }

  get controls() {
    return [
      this.columnDisplay(),
      this.searchTableButton(),
      this.clearSearchButton(),
      this.refreshTableButton(),
      ` <button
        class="btn btn-info"
        onclick="eNMS.automation.displayCalendar('run')"
        data-tooltip="Calendar"
        type="button"
      >
        <span class="glyphicon glyphicon-calendar"></span>
      </button>`,
    ];
  }

  buttons(row) {
    return [
      `<ul class="pagination pagination-lg" style="margin: 0px; width: 100px">
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.automation.showRuntimePanel('logs', ${row.service},
          '${row.runtime}')" data-tooltip="Logs">
          <span class="glyphicon glyphicon-list"></span></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.automation.showRuntimePanel('results', ${row.service},
          '${row.runtime}')" data-tooltip="Results">
          <span class="glyphicon glyphicon-list-alt"></span></button>
        </li>
      </ul>`,
    ];
  }
};

tables.result = class ResultTable extends Table {
  addRow({ properties, tableId }) {
    const status = properties.success;
    delete properties.success;
    delete properties.result;
    let row = super.addRow({
      properties: properties,
      tableId: tableId,
      derivedProperties: ["service_name", "device_name"],
    });
    row.status = status;
    row.success = `
      <button
        type="button"
        class="btn btn-${status ? "success" : "danger"} btn-sm"
        style="width:100%">${status ? "Success" : "Failure"}
      </button>`;
    row.v1 = `<input type="radio" name="v1-${tableId}" value="${row.id}">`;
    row.v2 = `<input type="radio" name="v2-${tableId}" value="${row.id}">`;
    return row;
  }

  get controls() {
    const id = this.constraints.service_id || this.constraints.device_id;
    return [
      `<button
        class="btn btn-info"
        onclick="eNMS.automation.displayDiff('${this.type}', ${id})"
        data-tooltip="Compare"
        type="button"
      >
        <span class="glyphicon glyphicon-adjust"></span>
      </button>`,
      this.refreshTableButton(),
      this.clearSearchButton(),
    ];
  }

  buttons(row) {
    return [
      `
    <ul class="pagination pagination-lg" style="margin: 0px; width: 90px">
      <li>
        <button type="button" class="btn btn-sm btn-info"
        onclick="eNMS.automation.showResult('${row.id}')"
        data-tooltip="Results"><span class="glyphicon glyphicon-list-alt">
        </span></button>
      </li>
      <li>
        <button
          type="button"
          id="btn-result-${row.id}"
          class="btn btn-sm btn-info"
          onclick="eNMS.automation.copyClipboard(
            'btn-result-${row.id}', ${row.instance}
          )"
          data-tooltip="Copy to clipboard"
        ><span class="glyphicon glyphicon-copy"></span></button>
      </li>
    </ul>`,
    ];
  }
};

tables.full_result = class FullResultTable extends tables.result {
  get filteringData() {
    return { full_result: true };
  }

  get modelFiltering() {
    return "result";
  }
};

tables.device_result = class DeviceResultTable extends tables.result {
  get modelFiltering() {
    return "result";
  }
};

tables.task = class TaskTable extends Table {
  addRow(kwargs) {
    let row = super.addRow(kwargs);
    if (row.scheduling_mode == "standard") {
      row.periodicity = `${row.frequency} ${row.frequency_unit}`;
    } else {
      row.periodicity = row.crontab_expression;
    }
    for (const model of ["device", "pool"]) {
      row[`${model}s`] = `<b><a href="#" onclick="eNMS.table.displayRelationTable(
        '${model}', ${row.instance}, {from: 'tasks', to: '${model}s'})">
        ${model.charAt(0).toUpperCase() + model.slice(1)}s</a></b>`;
    }
    return row;
  }

  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.searchTableButton(),
      this.clearSearchButton(),
      ` <button
        class="btn btn-info"
        onclick="eNMS.automation.displayCalendar('task')"
        data-tooltip="Calendar"
        type="button"
      >
        <span class="glyphicon glyphicon-calendar"></span>
      </button>`,
      this.createNewButton(),
      this.bulkEditButton(),
      ` <button
        type="button"
        class="btn btn-success"
        onclick="eNMS.automation.schedulerAction('resume')"
        data-tooltip="Bulk Resume"
      >
        <span class="glyphicon glyphicon-play"></span>
      </button>
      <button
        type="button"
        class="btn btn-danger"
        onclick="eNMS.automation.schedulerAction('pause')"
        data-tooltip="Bulk Pause"
      >
        <span class="glyphicon glyphicon-pause"></span>
      </button>`,
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    const state = row.is_active ? ["disabled", "active"] : ["active", "disabled"];
    return [
      `<ul class="pagination pagination-lg" style="margin: 0px;">
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('task', '${row.id}')" data-tooltip="Edit"
            ><span class="glyphicon glyphicon-edit"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('task', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate">
          <span class="glyphicon glyphicon-duplicate"></span></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-success ${state[0]}" ${state[0]}
          onclick="eNMS.automation.resumeTask('${row.id}')" data-tooltip="Play"
            ><span class="glyphicon glyphicon-play"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-danger ${state[1]}" ${state[1]}
          onclick="eNMS.automation.pauseTask('${row.id}')" data-tooltip="Pause"
            ><span class="glyphicon glyphicon-pause"></span
          ></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>`,
    ];
  }
};

tables.user = class UserTable extends Table {
  addRow(kwargs) {
    let row = super.addRow(kwargs);
    row.pools = `<b><a href="#" onclick="eNMS.table.displayRelationTable(
      'pool', ${row.instance}, {from: 'users', to: 'pools'})">
      Pools</a></b>`;
    return row;
  }

  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.searchTableButton(),
      this.clearSearchButton(),
      this.copyTableButton(),
      this.createNewButton(),
      this.bulkEditButton(),
      this.exportTableButton(),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return [
      `
      <ul class="pagination pagination-lg" style="margin: 0px;">
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('user', '${row.id}')" data-tooltip="Edit"
            ><span class="glyphicon glyphicon-edit"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('user', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate"
            ><span class="glyphicon glyphicon-duplicate"></span
          ></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>`,
    ];
  }
};

tables.access = class AccessTable extends Table {
  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.searchTableButton(),
      this.clearSearchButton(),
      this.createNewButton(),
      this.exportTableButton(),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return [
      `
      <ul class="pagination pagination-lg" style="margin: 0px;">
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('access', '${
            row.id
          }')" data-tooltip="Edit"
            ><span class="glyphicon glyphicon-edit"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('access', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate"
            ><span class="glyphicon glyphicon-duplicate"></span
          ></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>`,
    ];
  }
};

tables.credential = class CredentialTable extends Table {
  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.clearSearchButton(),
      this.createNewButton(),
      this.bulkEditButton(),
      this.exportTableButton(),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return [
      `
      <ul class="pagination pagination-lg" style="margin: 0px;">
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('credential', '${row.id}')"
          data-tooltip="Edit"><span class="glyphicon glyphicon-edit"></span></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('credential', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate"
            ><span class="glyphicon glyphicon-duplicate"></span
          ></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>`,
    ];
  }
};

tables.server = class ServerTable extends Table {
  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.clearSearchButton(),
      this.createNewButton(),
      this.bulkEditButton(),
      this.exportTableButton(),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return [
      `
      <ul class="pagination pagination-lg" style="margin: 0px;">
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('server', '${
            row.id
          }')" data-tooltip="Edit"
            ><span class="glyphicon glyphicon-edit"></span
          ></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('server', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate"
            ><span class="glyphicon glyphicon-duplicate"></span
          ></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>`,
    ];
  }
};

tables.changelog = class ChangelogTable extends Table {
  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.clearSearchButton(),
      this.createNewButton(),
      this.exportTableButton(),
    ];
  }
};

tables.session = class SessionTable extends Table {
  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton("session"),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return [
      `
      <ul class="pagination pagination-lg" style="margin: 0px;">
        <li>
          <button type="button" class="btn btn-sm btn-info"
          onclick="eNMS.inventory.showSessionLog(${row.id})" data-tooltip="Session Log"
            ><span class="glyphicon glyphicon-list"></span
          ></button>
        </li>
      </ul>`,
    ];
  }
};

tables.event = class EventTable extends Table {
  get controls() {
    return [
      this.columnDisplay(),
      this.refreshTableButton(),
      this.clearSearchButton(),
      this.createNewButton(),
      this.exportTableButton(),
      this.bulkDeletionButton(),
    ];
  }

  buttons(row) {
    return [
      `
      <ul class="pagination pagination-lg" style="margin: 0px; width: 150px">
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('event', '${row.id}')"
          data-tooltip="Edit"><span class="glyphicon glyphicon-edit">
          </span></button>
        </li>
        <li>
          <button type="button" class="btn btn-sm btn-primary"
          onclick="eNMS.base.showInstancePanel('event', '${row.id}', 'duplicate')"
          data-tooltip="Duplicate">
          <span class="glyphicon glyphicon-duplicate"></span></button>
        </li>
        ${this.deleteInstanceButton(row)}
      </ul>
    `,
    ];
  }
};

export const clearSearch = function (tableId, notification) {
  $(`.search-input-${tableId},.search-list-${tableId}`).val("");
  $(".search-relation-dd").val("any").selectpicker("refresh");
  $(".search-relation").val([]).trigger("change");
  $(`.search-select-${tableId}`).val("inclusion");
  refreshTable(tableId);
  if (notification) notify("Search parameters cleared.", "success", 5);
};

function copySelectionToClipboard(tableId) {
  let table = tableInstances[tableId];
  table.copyClipboard = true;
  refreshTable(tableId);
}

function exportTable(tableId) {
  let table = tableInstances[tableId];
  table.csvExport = true;
  refreshTable(tableId);
}

export const refreshTable = function (tableId, notification) {
  if ($(`#table-${tableId}`).length) {
    tableInstances[tableId].table.ajax.reload(null, false);
  }
  if (notification) notify("Table refreshed.", "success", 5);
};

function refreshTablePeriodically(tableId, interval, first) {
  if (userIsActive && !first) refreshTable(tableId, false);
  setTimeout(() => refreshTablePeriodically(tableId, interval), interval);
}

function showBulkDeletionPanel(tableId, model) {
  openPanel({
    name: "bulk_deletion",
    id: tableId,
    content: `
      <div class="modal-body">
        Are you sure you want to permanently remove all items
        currently displayed in the table ?
      </div>
      <div class="modal-footer">
        <center>
          <button
            type="button"
            class="btn btn-danger"
            onclick="eNMS.table.bulkDeletion('${tableId}', '${model}')"
          >
            Delete
          </button>
        </center>
      </div><br>`,
    title: "Bulk Deletion (delete all items in table)",
    size: "auto",
  });
}

function bulkDeletion(tableId, model) {
  call({
    url: `/bulk_deletion/${model}`,
    form: `search-form-${tableId}`,
    callback: function (number) {
      refreshTable(tableId);
      $(`#bulk_deletion-${tableId}`).remove();
      notify(`${number} items deleted.`, "success", 5, true);
    },
  });
}

function bulkRemoval(tableId, model, instance) {
  const relation = `${instance.relation.to}/${instance.relation.from}`;
  call({
    url: `/bulk_removal/${model}/${instance.type}/${instance.id}/${relation}`,
    form: `search-form-${tableId}`,
    callback: function (number) {
      refreshTable(tableId);
      if (instance.type == "pool") refreshTable("pool");
      notify(
        `${number} ${model}s removed from ${instance.type} '${instance.name}'.`,
        "success",
        5,
        true
      );
    },
  });
}

function bulkEdit(formId, model, table) {
  call({
    url: `/bulk_edit/${model}`,
    form: `${formId}-form`,
    callback: function (number) {
      refreshTable(table);
      $(`#${formId}`).remove();
      notify(`${number} items modified.`, "success", 5, true);
    },
  });
}

function displayRelationTable(type, instance, relation) {
  openPanel({
    name: "table",
    content: `
      <div class="modal-body">
        <div id="tooltip-overlay" class="overlay"></div>
        <form
          id="search-form-${type}-${instance.id}"
          class="form-horizontal form-label-left"
          method="post"
        >
          <nav
            id="controls-${type}-${instance.id}"
            class="navbar navbar-default nav-controls"
            role="navigation"
          ></nav>
          <table
            id="table-${type}-${instance.id}"
            class="table table-striped table-bordered table-hover"
            cellspacing="0"
            width="100%"
          ></table>
        </form>
      </div>`,
    id: instance.id,
    size: "1200 600",
    title: `${instance.name} - ${type}s`,
    callback: function () {
      const constraints = { [`${relation.from}`]: [instance.id] };
      // eslint-disable-next-line new-cap
      new tables[type](instance.id, constraints, { relation, ...instance });
    },
  });
}

for (const [type, table] of Object.entries(tables)) {
  table.prototype.type = type;
}

configureNamespace("table", [
  bulkDeletion,
  bulkEdit,
  bulkRemoval,
  clearSearch,
  copySelectionToClipboard,
  displayRelationTable,
  exportTable,
  refreshTable,
  showBulkDeletionPanel,
]);
